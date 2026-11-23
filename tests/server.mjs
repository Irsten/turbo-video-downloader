// Lokalny serwer testowy: pliki z Range, HLS, wstrzykiwanie błędów.
import http from 'node:http';
import crypto from 'node:crypto';

export const SIZE = 20 * 1024 * 1024 + 12345;
export const DATA = crypto.randomBytes(SIZE);
DATA[0] = 0x00; // prawdziwy kontener nie zaczyna się od "<"

const segData = new Map();
export function segment(name) {
  if (!segData.has(name)) {
    const b = crypto.createHash('sha256').update(name).digest();
    const buf = Buffer.alloc(150 * 1024 + (b[0] << 4));
    for (let i = 0; i < buf.length; i++) buf[i] = b[i % 32] ^ (i & 0xff);
    buf[0] = 0x47; // bajt synchronizacji TS
    segData.set(name, buf);
  }
  return segData.get(name);
}

export const SEGMENTS = 20;
const mediaPlaylist = (dir, ext) =>
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n' +
  Array.from({ length: SEGMENTS }, (_, i) => `#EXTINF:4.0,\n${dir}/seg${i}.${ext}\n`).join('') +
  '#EXT-X-ENDLIST\n';

export const MASTER =
  '#EXTM3U\n' +
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="pl",LANGUAGE="pl",DEFAULT=YES,URI="audio.m3u8"\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"\nv720.m3u8\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"\nv360.m3u8\n';

export const state = {
  flakyBudget: Infinity, // ile bajtów /flaky.mp4 obsłuży, zanim zacznie odpowiadać 404
  served: {}, // ścieżka -> bajty treści wysłane
  requests: {}, // ścieżka -> liczba żądań
  failSegments: new Map(), // nazwa segmentu -> status (np. 404, 403) albo 'html'
  slow: false
};
export function resetCounters() {
  state.served = {};
  state.requests = {};
}

const HTML = '<!doctype html><html><body>Zaloguj się, aby obejrzeć film</body></html>';

function sendRange(req, res, buf, type, { ignoreRange = false, path } = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let start = 0;
  let end = buf.length - 1;
  if (m && !ignoreRange) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), buf.length - 1);
    if (start >= buf.length) {
      res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${buf.length}`,
      'accept-ranges': 'bytes'
    });
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length });
  }
  const body = buf.subarray(start, end + 1);
  const count = (n) => (state.served[path] = (state.served[path] || 0) + n);
  if (!state.slow) {
    count(body.length);
    return res.end(body);
  }
  // Wolne łącze: 256 KiB co 15 ms.
  let pos = 0;
  const step = () => {
    if (res.destroyed) return;
    const part = body.subarray(pos, pos + 256 * 1024);
    pos += part.length;
    count(part.length);
    if (pos >= body.length) return res.end(part);
    res.write(part);
    setTimeout(step, 15);
  };
  step();
}

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.requests[p] = (state.requests[p] || 0) + 1;
    res.setHeader('access-control-allow-origin', '*');

    if (p === '/ok.mp4') return sendRange(req, res, DATA, 'video/mp4', { path: p });
    if (p === '/norange.mp4') return sendRange(req, res, DATA, 'video/mp4', { ignoreRange: true, path: p });
    if (p === '/php.mp4') return sendRange(req, res, DATA, 'text/html; charset=UTF-8', { path: p });
    if (p === '/expired.mp4') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (p === '/forbid.mp4') {
      if (req.headers.range === 'bytes=0-0') return sendRange(req, res, DATA, 'video/mp4', { path: p });
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }
    if (p === '/flaky.mp4') {
      if ((state.served[p] || 0) >= state.flakyBudget) {
        res.writeHead(404);
        return res.end();
      }
      return sendRange(req, res, DATA, 'video/mp4', { path: p });
    }

    // ---------- HLS ----------
    const pl = (body) => {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(body);
    };
    if (p === '/hls/master.m3u8') return pl(MASTER);
    if (p === '/hls/v720.m3u8') return pl(mediaPlaylist('v720', 'ts'));
    if (p === '/hls/v360.m3u8') return pl(mediaPlaylist('v360', 'ts'));
    if (p === '/hls/audio.m3u8') return pl(mediaPlaylist('a', 'aac'));
    if (p === '/hls/login.m3u8') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(HTML);
    }
    const seg = /^\/hls\/((?:v720|v360|a)\/seg\d+\.(?:ts|aac))$/.exec(p);
    if (seg) {
      const fail = state.failSegments.get(seg[1]);
      if (fail === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(HTML);
      }
      if (fail) {
        res.writeHead(fail);
        return res.end();
      }
      return sendRange(req, res, segment(seg[1]), 'video/mp2t', { path: '/hls/*' });
    }

    // ---------- strony do testów rozszerzenia ----------
    if (pages[p]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pages[p]);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export const pages = {};
