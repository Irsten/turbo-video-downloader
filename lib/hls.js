// Parser playlist HLS (.m3u8): master (lista jakości) i media (lista segmentów).

export function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function parseByteRange(spec, lastEnd) {
  // "<długość>[@<offset>]"
  const [len, off] = String(spec).split('@');
  const length = Number(len);
  const start = off != null && off !== '' ? Number(off) : lastEnd ?? 0;
  return [start, start + length - 1];
}

/**
 * @returns {{kind:'master', variants:Array, audios:Array, encrypted:boolean}
 *          | {kind:'media', segments:Array, duration:number, endList:boolean, encrypted:boolean, keyMethod:string}}
 */
export function parseM3U8(text, baseUrl) {
  const lines = String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error('To nie jest playlista HLS (.m3u8)');
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, abs);
  return parseMedia(lines, abs);
}

function parseMaster(lines, abs) {
  const variants = [];
  const audios = [];
  let encrypted = false;
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j >= lines.length) break;
      const url = abs(lines[j]);
      i = j;
      if (seen.has(url)) continue;
      seen.add(url);
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url,
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        width: w || 0,
        height: h || 0,
        codecs: a.CODECS || '',
        audio: a.AUDIO || '',
        frameRate: Number(a['FRAME-RATE']) || 0
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO') {
        audios.push({
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          default: a.DEFAULT === 'YES',
          url: a.URI ? abs(a.URI) : null
        });
      }
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttrs(line.slice(19));
      if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
    }
  }
  variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  return { kind: 'master', variants, audios, encrypted };
}

function parseMedia(lines, abs) {
  const segments = [];
  const lastEnd = new Map(); // url -> następny bajt (dla BYTERANGE bez offsetu)
  let duration = 0;
  let curDur = 0;
  let pendingRange = null;
  let map = null;
  let encrypted = false;
  let keyMethod = 'NONE';
  let endList = false;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      curDur = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      keyMethod = a.METHOD || 'NONE';
      if (keyMethod !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      if (a.URI) {
        map = { url: abs(a.URI) };
        if (a.BYTERANGE) map.range = parseByteRange(a.BYTERANGE, 0);
      }
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (!line.startsWith('#')) {
      const url = abs(line);
      const seg = { url, duration: curDur, map };
      if (pendingRange) {
        seg.range = parseByteRange(pendingRange, lastEnd.get(url));
        lastEnd.set(url, seg.range[1] + 1);
        pendingRange = null;
      }
      segments.push(seg);
      duration += curDur;
      curDur = 0;
    }
  }
  return { kind: 'media', segments, duration, endList, encrypted, keyMethod };
}

/** Wybiera wariant: po adresie, albo najwyższej jakości. */
export function pickVariant(master, variantUrl) {
  if (variantUrl) {
    const v = master.variants.find((x) => x.url === variantUrl);
    if (v) return v;
  }
  return master.variants[0];
}

export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.frameRate && v.frameRate > 30.5) parts.push(`${Math.round(v.frameRate)}fps`);
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1e6).toFixed(v.bandwidth < 1e6 ? 2 : 1)} Mb/s`);
  return parts.join(' · ') || 'wariant';
}
