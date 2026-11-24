// Shared helpers: URL classification, file names, formatting.
import { tr } from './i18n.js';

export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'flv', 'ogv', 'avi', '3gp', 'wmv'];
const SEGMENT_EXT = ['ts', 'm4s', 'cmfv', 'cmfa', 'aac', 'm4a', 'mp3', 'vtt', 'webvtt', 'key'];

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
  'video/x-ms-wmv': 'wmv',
  'video/x-m4v': 'm4v'
};

// MIME type of the saved file. Without it Opera/Chromium may change the extension
// (e.g. .ts → .txt), because it treats an unnamed Blob as text.
const EXT_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  wmv: 'video/x-ms-wmv',
  ts: 'video/mp2t',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg'
};

export function mimeForExt(ext) {
  return EXT_MIME[String(ext).toLowerCase()] || 'application/octet-stream';
}

const HLS_MIME = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const DASH_MIME = ['application/dash+xml'];

// Hosts we deliberately don't support (signed DASH streams, terms of service forbid downloading).
const BLOCKED_HOSTS = [/(^|\.)googlevideo\.com$/i];

export function isBlockedHost(url) {
  try {
    const host = new URL(url).hostname;
    return BLOCKED_HOSTS.some((re) => re.test(host));
  } catch {
    return true;
  }
}

export function isHttp(url) {
  return /^https?:\/\//i.test(url || '');
}

/**
 * Sub-page of a tab: the address without query and hash. Changing only ?t=… or #… is still the same
 * page, but moving to another path in an SPA (X, Instagram…) is not.
 */
export function pageKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return '';
  }
}

export function urlExt(url) {
  try {
    const path = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,6})$/i.exec(path);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

export function mimeBase(ct) {
  return (ct || '').split(';')[0].trim().toLowerCase();
}

export function extFromMime(ct) {
  return MIME_EXT[mimeBase(ct)] || '';
}

/**
 * Returns 'file' | 'hls' | 'dash' | null.
 */
export function classify(url, contentType = '') {
  let host = '';
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (BLOCKED_HOSTS.some((re) => re.test(host))) return null;

  const ext = urlExt(url);
  const mime = mimeBase(contentType);

  if (ext === 'm3u8' || HLS_MIME.includes(mime)) return 'hls';
  if (ext === 'mpd' || DASH_MIME.includes(mime)) return 'dash';
  if (SEGMENT_EXT.includes(ext)) return null;
  if (mime === 'video/mp2t' || mime === 'video/iso.segment') return null;
  if (VIDEO_EXT.includes(ext)) return 'file';
  if (mime.startsWith('video/')) return 'file';
  return null;
}

/** Key for removing duplicates (drops range parameters added by players). */
export function dedupeKey(url) {
  try {
    const u = new URL(url);
    for (const p of ['range', 'bytes', 'rn', 'rbuf', 'bytestart', 'byteend']) u.searchParams.delete(p);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

export function sanitizeFilename(name, fallback = 'video') {
  let s = String(name || '')
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!s) s = fallback;
  // Cut by code points, not UTF-16 units – an emoji cut in half would leave a broken character.
  const chars = Array.from(s);
  if (chars.length > 120) s = chars.slice(0, 120).join('').trim();
  // Names reserved on Windows
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
}

// ---------- file name template ----------

export const DEFAULT_TEMPLATE = '{title} [{quality}]';
const TEMPLATE_KEYS = { // Polish names stay as aliases (templates saved by older versions)
  tytuł: 'title',
  tytul: 'title',
  title: 'title',
  jakość: 'quality',
  jakosc: 'quality',
  quality: 'quality',
  plik: 'file',
  file: 'file',
  strona: 'host',
  host: 'host', site: 'host',
  data: 'date',
  date: 'date'
};
export const templateHelp = () => tr('templateHelp');

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * File name (without extension) from a template. vars: { title, quality, file, host }.
 * Empty variables disappear together with the brackets around them: "{title} [{quality}]" → "Video" when there is no quality.
 * When the result is empty – the name from the address or "video".
 */
export function applyTemplate(template, vars = {}) {
  const v = { date: today(), ...vars };
  const tpl = String(template || '').trim() || DEFAULT_TEMPLATE;
  const filled = tpl
    .replace(/\{([^{}]+)\}/g, (m, k) => {
      const key = TEMPLATE_KEYS[k.trim().toLowerCase()];
      return key ? sanitizeFilename(v[key] ?? '', '') : m;
    })
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s*[-–·_]\s*$|^\s*[-–·_]\s*/g, '');
  return sanitizeFilename(filled, sanitizeFilename(v.file, 'video'));
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last.replace(/\.[a-z0-9]{2,6}$/i, '');
  } catch {
    return '';
  }
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (sec == null || !isFinite(sec)) return '?';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
