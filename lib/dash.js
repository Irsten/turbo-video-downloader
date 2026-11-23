// Parser of DASH manifests (.mpd) without DRM: works out the list of segments (or a single file) for each
// representation. Supports SegmentTemplate ($Number$/$Time$, SegmentTimeline), SegmentList,
// SegmentBase / a bare BaseURL (whole file) and BaseURL inheritance.
import { parseXml, kids, kid } from './xml.js';

const MAX_SEGMENTS = 200000;

/** ISO 8601 duration (PT1H2M3.5S) in seconds. */
export function parseDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    String(s || '').trim()
  );
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m.map((x) => Number(x) || 0);
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + sec;
}

const range = (s) => {
  const m = /^(\d+)-(\d+)$/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};

function fill(tpl, v) {
  return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (_, name, width) => {
    if (!name) return '$';
    const val = String({ RepresentationID: v.id, Number: v.number, Time: v.time, Bandwidth: v.bandwidth }[name] ?? '');
    return width && name !== 'RepresentationID' ? val.padStart(Number(width), '0') : val;
  });
}

function baseUrl(el, parent) {
  const b = kid(el, 'BaseURL');
  return b && b.text.trim() ? new URL(b.text.trim(), parent).href : parent;
}

/** SegmentTemplate/SegmentList attributes from the Period → AdaptationSet → Representation levels. */
function merged(levels, name) {
  let attrs = null;
  let node = null;
  for (const l of levels) {
    const n = kid(l, name);
    if (n) {
      attrs = { ...(attrs || {}), ...n.attrs };
      node = n;
    }
  }
  return attrs ? { attrs, node, timeline: levels.map((l) => kid(kid(l, name), 'SegmentTimeline')).filter(Boolean).pop() } : null;
}

function kindOf(as, rep) {
  const ct = as.attrs.contentType || rep.attrs.contentType || '';
  const mime = rep.attrs.mimeType || as.attrs.mimeType || '';
  const codecs = (rep.attrs.codecs || as.attrs.codecs || '').toLowerCase();
  if (ct === 'text' || mime.startsWith('text/') || /stpp|wvtt|ttml/.test(codecs) || mime.includes('ttml')) return 'text';
  if (ct === 'video' || mime.startsWith('video/')) return 'video';
  if (ct === 'audio' || mime.startsWith('audio/')) return 'audio';
  return 'other';
}

function containerOf(kind, mime, codecs) {
  if (mime.includes('webm')) return 'webm';
  if (mime === 'text/vtt') return 'vtt';
  if (mime.includes('ttml') || /stpp|ttml/.test(codecs)) return 'ttml';
  if (kind === 'text') return 'mp4text';
  return 'mp4';
}

/**
 * Returns { dynamic, duration, encrypted, multiPeriod, video, audio, text } – lists of representations:
 * { id, kind, mimeType, codecs, bandwidth, width, height, frameRate, lang, label, encrypted,
 *   container, single (whole file), url, init: {url, range}|null, segments: [{url, range, duration}] }
 */
export function parseMpd(text, manifestUrl) {
  const mpd = parseXml(text);
  if (!mpd || mpd.name !== 'MPD') throw new Error('This is not a DASH manifest (.mpd)');
  const dynamic = mpd.attrs.type === 'dynamic';
  const total = parseDuration(mpd.attrs.mediaPresentationDuration);
  const periods = kids(mpd, 'Period');
  const mpdBase = baseUrl(mpd, manifestUrl);
  const out = { dynamic, duration: total, encrypted: false, multiPeriod: periods.length > 1, video: [], audio: [], text: [] };

  // The first period containing video or audio.
  const pi = Math.max(
    0,
    periods.findIndex((p) => kids(p, 'AdaptationSet').some((as) => kids(as, 'Representation').some((r) => ['video', 'audio'].includes(kindOf(as, r)))))
  );
  const period = periods[pi];
  if (!period) return out;
  const pStart = parseDuration(period.attrs.start);
  const nextStart = periods[pi + 1] ? parseDuration(periods[pi + 1].attrs.start) : null;
  const pDuration = parseDuration(period.attrs.duration) || (nextStart != null ? nextStart - pStart : total - pStart) || total;
  out.duration = pDuration || total;
  const pBase = baseUrl(period, mpdBase);

  for (const as of kids(period, 'AdaptationSet')) {
    const asBase = baseUrl(as, pBase);
    const asProtected = kids(as, 'ContentProtection').length > 0;
    const label = kid(as, 'Label')?.text.trim() || as.attrs.label || '';
    for (const rep of kids(as, 'Representation')) {
      const kind = kindOf(as, rep);
      if (kind === 'other') continue;
      const mimeType = rep.attrs.mimeType || as.attrs.mimeType || '';
      const codecs = rep.attrs.codecs || as.attrs.codecs || '';
      const encrypted = asProtected || kids(rep, 'ContentProtection').length > 0;
      if (encrypted) out.encrypted = true;
      const url = baseUrl(rep, asBase);
      const r = {
        id: rep.attrs.id || '',
        kind,
        mimeType,
        codecs,
        bandwidth: Number(rep.attrs.bandwidth) || 0,
        width: Number(rep.attrs.width || as.attrs.width) || 0,
        height: Number(rep.attrs.height || as.attrs.height) || 0,
        frameRate: frameRate(rep.attrs.frameRate || as.attrs.frameRate),
        lang: as.attrs.lang || rep.attrs.lang || '',
        label,
        encrypted,
        container: containerOf(kind, mimeType, codecs.toLowerCase()),
        single: false,
        url,
        init: null,
        segments: []
      };
      Object.assign(r, segmentsFor([period, as, rep], r, url, pDuration));
      out[kind].push(r);
    }
  }
  out.video.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  out.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

function frameRate(s) {
  if (!s) return 0;
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : a || 0;
}

function segmentsFor(levels, rep, base, periodDuration) {
  const vars = { id: rep.id, bandwidth: rep.bandwidth };
  const tpl = merged(levels, 'SegmentTemplate');
  if (tpl && tpl.attrs.media) {
    const a = tpl.attrs;
    const timescale = Number(a.timescale) || 1;
    const startNumber = a.startNumber != null ? Number(a.startNumber) : 1;
    const segments = [];
    if (tpl.timeline) {
      let time = 0;
      let number = startNumber;
      const S = kids(tpl.timeline, 'S');
      const end = Number(a.presentationTimeOffset || 0) + periodDuration * timescale;
      S.forEach((s, i) => {
        if (s.attrs.t != null) time = Number(s.attrs.t);
        const d = Number(s.attrs.d);
        let r = Number(s.attrs.r || 0);
        if (r < 0) {
          const nextT = S[i + 1]?.attrs.t != null ? Number(S[i + 1].attrs.t) : end;
          r = Math.ceil((nextT - time) / d) - 1;
        }
        for (let k = 0; k <= r && segments.length < MAX_SEGMENTS; k++) {
          segments.push({ url: new URL(fill(a.media, { ...vars, number, time }), base).href, duration: d / timescale });
          time += d;
          number++;
        }
      });
    } else if (a.duration) {
      const d = Number(a.duration);
      const count = Math.min(MAX_SEGMENTS, Math.ceil((periodDuration * timescale) / d - 1e-9));
      for (let k = 0; k < count; k++) {
        segments.push({
          url: new URL(fill(a.media, { ...vars, number: startNumber + k, time: k * d }), base).href,
          duration: d / timescale
        });
      }
    }
    const init = a.initialization ? { url: new URL(fill(a.initialization, vars), base).href } : null;
    return { init, segments };
  }

  const list = merged(levels, 'SegmentList');
  if (list) {
    const node = levels.map((l) => kid(l, 'SegmentList')).filter(Boolean).pop();
    const timescale = Number(list.attrs.timescale) || 1;
    const d = Number(list.attrs.duration) || 0;
    const initNode = kid(node, 'Initialization') || levels.map((l) => kid(kid(l, 'SegmentList'), 'Initialization')).filter(Boolean).pop();
    const init = initNode
      ? { url: new URL(initNode.attrs.sourceURL || base, base).href, range: range(initNode.attrs.range) }
      : null;
    const segments = kids(node, 'SegmentURL').map((s) => ({
      url: new URL(s.attrs.media || base, base).href,
      range: range(s.attrs.mediaRange),
      duration: d / timescale
    }));
    return { init, segments };
  }

  // SegmentBase or a bare BaseURL: one file with the whole representation.
  return { single: true, init: null, segments: [] };
}

/** Description of a representation for the selection list. */
export function representationLabel(r) {
  const parts = [];
  if (r.height) parts.push(`${r.height}p`);
  if (r.frameRate > 30.5) parts.push(`${Math.round(r.frameRate)}fps`);
  if (r.bandwidth) parts.push(`${(r.bandwidth / 1e6).toFixed(r.bandwidth < 1e6 ? 2 : 1)} Mb/s`);
  return parts.join(' · ') || r.id || 'variant';
}

/** Audio tracks to choose from: the best representation of each group (language/label). */
export function dashAudioOptions(mpd) {
  const best = new Map();
  for (const r of mpd.audio) {
    if (r.encrypted) continue;
    const key = `${r.lang}|${r.label}`;
    if (!best.has(key) || best.get(key).bandwidth < r.bandwidth) best.set(key, r);
  }
  return [...best.values()];
}
