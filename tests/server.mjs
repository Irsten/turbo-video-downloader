// Local test server: files with Range, HLS, DASH, live streams, injected errors.
import http from 'node:http';
import crypto from 'node:crypto';

export const SIZE = 20 * 1024 * 1024 + 12345;
export const DATA = crypto.randomBytes(SIZE);
DATA[0] = 0x00; // a real container never starts with "<"

const segData = new Map();
export function segment(name) {
  if (!segData.has(name)) {
    const b = crypto.createHash('sha256').update(name).digest();
    const buf = Buffer.alloc(150 * 1024 + (b[0] << 4));
    for (let i = 0; i < buf.length; i++) buf[i] = b[i % 32] ^ (i & 0xff);
    buf[0] = 0x47; // TS sync byte
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
  flakyBudget: Infinity, // how many bytes /flaky.mp4 serves before it starts answering 404
  served: {}, // path -> body bytes sent
  requests: {}, // path -> number of requests
  failSegments: new Map(), // segment name -> status (e.g. 404, 403) or 'html'
  slow: false, // slow connection: slowChunk bytes every slowDelay ms per connection
  slowChunk: 256 * 1024,
  slowDelay: 15
};
export function resetCounters() {
  state.served = {};
  state.requests = {};
}

const HTML = '<!doctype html><html><body>Sign in to watch the video</body></html>';

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
  // Slow connection: state.slowChunk bytes every state.slowDelay ms.
  let pos = 0;
  const step = () => {
    if (res.destroyed) return;
    const part = body.subarray(pos, pos + state.slowChunk);
    pos += part.length;
    count(part.length);
    if (pos >= body.length) return res.end(part);
    res.write(part);
    setTimeout(step, state.slowDelay);
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

    // ---------- live stream: a new segment every liveState.step ms, a window of 3 segments ----------
    if (p.startsWith('/live/')) return live(req, res, p);

    // ---------- pages for the extension tests ----------
    if (pages[p]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pages[p]);
    }
    // ---------- arbitrary files (media tests) ----------
    const a = assets[p];
    if (a) {
      if (a.fail) {
        res.writeHead(a.fail);
        return res.end();
      }
      const body = typeof a.body === 'function' ? a.body() : a.body;
      return sendRange(req, res, Buffer.from(body), a.type || 'application/octet-stream', { path: p });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export const pages = {};
/** path -> { type, body (Buffer | string | () => …), fail (status) } */
export const assets = {};

// ---------------- live stream ----------------
export const liveState = {
  start: 0,
  step: 700, // ms per segment (short, so the test doesn't take long)
  ended: false, // ENDLIST once finished
  segments: (n) => segment(`live/seg${n}.ts`), // contents of segment no. n
  window: 3,
  ext: 'ts',
  map: null // e.g. 'init.mp4' for fMP4
};
export function liveReset(opts = {}) {
  Object.assign(liveState, { start: Date.now(), ended: false, window: 3, ext: 'ts', map: null }, opts);
}
const liveAvailable = () => Math.max(1, Math.floor((Date.now() - liveState.start) / liveState.step) + 1);

function live(req, res, p) {
  if (p === '/live/index.m3u8') {
    const n = liveAvailable();
    const first = Math.max(0, n - liveState.window);
    let s = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
    if (liveState.map) s += `#EXT-X-MAP:URI="${liveState.map}"\n`;
    for (let i = first; i < n; i++) s += `#EXTINF:${(liveState.step / 1000).toFixed(3)},\nseg${i}.${liveState.ext}\n`;
    if (liveState.ended) s += '#EXT-X-ENDLIST\n';
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
    return res.end(s);
  }
  const m = /^\/live\/seg(\d+)\.\w+$/.exec(p);
  if (m) {
    const n = Number(m[1]);
    if (n >= liveAvailable() || n < liveAvailable() - liveState.window - 2) {
      res.writeHead(404);
      return res.end();
    }
    return sendRange(req, res, Buffer.from(liveState.segments(n)), 'video/mp2t', { path: '/live/*' });
  }
  const a = assets[p];
  if (a) return sendRange(req, res, Buffer.from(a.body), a.type || 'application/octet-stream', { path: p });
  res.writeHead(404);
  res.end();
}
