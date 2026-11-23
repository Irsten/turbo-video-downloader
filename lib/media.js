// Wspólne funkcje: klasyfikacja adresów, nazwy plików, formatowanie.

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

// Typ MIME pliku do zapisu. Bez niego Opera/Chromium potrafi zmienić rozszerzenie
// (np. .ts → .txt), bo traktuje bezimienny Blob jak tekst.
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

// Hosty, których celowo nie obsługujemy (strumienie DASH z podpisami, regulamin zabrania pobierania).
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
 * Podstrona karty: adres bez parametrów i kotwicy. Zmiana samego ?t=… czy #… to nadal ta sama
 * strona, a przejście na inną ścieżkę w aplikacji SPA (X, Instagram…) – już nie.
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
 * Zwraca 'file' | 'hls' | 'dash' | null.
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

/** Klucz do usuwania duplikatów (odrzuca parametry zakresu dodawane przez odtwarzacze). */
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

export function sanitizeFilename(name, fallback = 'film') {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (s.length > 120) s = s.slice(0, 120).trim();
  // Nazwy zarezerwowane w Windows
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
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
