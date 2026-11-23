// Subtitles: reading WebVTT (also split into HLS segments with X-TIMESTAMP-MAP) and writing SRT,
// which players (VLC, MPC-HC, Windows) load automatically next to the video.

const TWO33 = 2 ** 33 / 90000;

function time(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** { map: { mpegts, local } | null, cues: [{ start, end, text }] } */
export function parseVtt(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  let map = null;
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('X-TIMESTAMP-MAP=')) {
      const mpegts = /MPEGTS:(\d+)/.exec(line);
      const loc = /LOCAL:([\d:.]+)/.exec(line);
      map = { mpegts: mpegts ? Number(mpegts[1]) : 0, local: loc ? time(loc[1]) || 0 : 0 };
      continue;
    }
    const arrow = line.indexOf('-->');
    if (arrow < 0) continue;
    const start = time(line.slice(0, arrow));
    const end = time(line.slice(arrow + 3));
    if (start == null || end == null) continue;
    const body = [];
    while (i + 1 < lines.length && lines[i + 1].trim() !== '') body.push(lines[++i]);
    if (body.length) cues.push({ start, end, text: body.join('\n') });
  }
  return { map, cues };
}

/**
 * Joins WebVTT segments into one list of cues on the timeline of the output file.
 * start – the moment (s, on the source PTS timeline) where the output begins; null = from the first subtitle.
 */
export function mergeVtt(segments, start = null) {
  const parsed = segments.map(parseVtt);
  const shifts = parsed.map((p) => (p.map ? p.map.mpegts / 90000 - p.map.local : null));
  const known = shifts.filter((s) => s !== null);
  let base = start ?? (known.length ? Math.min(...known) : 0);
  const seen = new Set();
  const cues = [];
  parsed.forEach((p, i) => {
    let shift = shifts[i] === null ? base : shifts[i];
    // Overflow of the 33-bit MPEG-TS clock between subtitles and video.
    while (shift - base > TWO33 / 2) shift -= TWO33;
    while (base - shift > TWO33 / 2) shift += TWO33;
    for (const c of p.cues) {
      const s = Math.max(0, c.start + shift - base);
      const e = c.end + shift - base;
      if (e <= 0) continue;
      const key = `${s.toFixed(3)}|${e.toFixed(3)}|${c.text}`;
      if (seen.has(key)) continue; // the same cue repeated in neighbouring segments
      seen.add(key);
      cues.push({ start: s, end: e, text: c.text });
    }
  });
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

const ENT = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '', quot: '"', apos: "'" };

/** Cue text for SRT: <i>, <b>, <u> stay; other VTT tags are removed. */
export function cleanCueText(t) {
  return t
    .replace(/<(\/?)([ibu])(?:\.[^>]*)?>/gi, '\u0001$1$2\u0002')
    .replace(/<[^>]*>/g, '')
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m
    )
    .trim();
}

function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${cleanCueText(c.text).replace(/\n/g, '\r\n')}\r\n`)
    .join('\r\n');
}
