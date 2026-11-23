// Łączenie w MP4 (lib/remux.js) sprawdzane odtwarzaczem Chrome: każdy wariant musi się wczytać,
// mieć obraz 320×180 i dźwięk, trwać ~8 s i dać się odtworzyć do końca.
// Uruchom: npm run test:remux
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, waitFor } from './cdp.mjs';
import { loadFixtures, buildTs, buildPackedAac, splitFmp4 } from './media.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fx = loadFixtures();

// Warianty: lista wejść (ścieżek), każde wejście to lista segmentów.
const SEG = [0, 2, 4, 6, 8];
const segs = (fn) => SEG.slice(0, -1).map((s, i) => fn(s, SEG[i + 1]));
const tsCc = () => ({ v: { cc: 0 }, a: { cc: 0 }, psi: 0 });
const cases = {
  'TS: obraz + dźwięk': [segs(((cc) => (a, b) => buildTs(fx, a, b, { cc }))(tsCc()))],
  'TS: klatki z przesunięciem PTS (ctts)': [segs(((cc) => (a, b) => buildTs(fx, a, b, { cto: 2, cc }))(tsCc()))],
  'TS: obraz + osobne packed AAC': [
    segs(((cc) => (a, b) => buildTs(fx, a, b, { audio: false, cc }))(tsCc())),
    segs((a, b) => buildPackedAac(fx, a, b))
  ],
  'fMP4: segmenty obrazu + segmenty dźwięku': (() => {
    const v = splitFmp4(fx.recVideo);
    const a = splitFmp4(fx.recAudio);
    return [
      [v.init, ...v.fragments],
      [a.init, ...a.fragments]
    ];
  })(),
  'fMP4: całe pliki (DASH SegmentBase)': [[fx.recVideo], [fx.recAudio]]
};

const assets = {};
for (const [name, inputs] of Object.entries(cases)) {
  assets[name] = inputs.map((list) => list.map((b) => Buffer.from(b).toString('base64')));
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>remux</title><body><script type="module">
import { remuxToMp4 } from '/lib/remux.js';
import { MemoryFile } from '/lib/store.js';
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function play(blob) {
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  document.body.append(v);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('błąd wczytania: ' + (v.error && v.error.message))); });
  const info = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  v.playbackRate = 4;
  await v.play();
  await Promise.race([new Promise((r) => (v.onended = r)), new Promise((r) => setTimeout(r, 8000))]);
  info.ended = v.ended;
  info.frames = v.getVideoPlaybackQuality().totalVideoFrames;
  info.audioBytes = v.webkitAudioDecodedByteCount;
  info.error = v.error && v.error.message;
  v.remove();
  return info;
}
window.runCase = async (inputs) => {
  const ins = inputs.map((list) => {
    const parts = []; let pos = 0;
    const bufs = list.map((s) => { const b = fromB64(s); parts.push([pos, b.length]); pos += b.length; return b; });
    return { blob: new Blob(bufs), parts };
  });
  const out = await remuxToMp4(ins, { scratch: new MemoryFile() });
  return { size: out.blob.size, duration: out.duration, start: out.start, ...(await play(out.blob)) };
};
window.ready = true;
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/lib/')) {
    const file = path.join(ROOT, url.pathname);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(fs.readFileSync(file));
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const chrome = await launchChrome();
let failed = 0;
try {
  const page = await chrome.openTarget(`http://127.0.0.1:${server.address().port}/`);
  await waitFor(() => chrome.evaluate(page.sessionId, 'window.ready === true'));
  for (const [name, inputs] of Object.entries(assets)) {
    let r;
    try {
      r = await chrome.evaluate(page.sessionId, `runCase(${JSON.stringify(inputs)})`);
    } catch (e) {
      r = { error: e.message };
    }
    const ok =
      !r.error && r.ended && r.width === 320 && r.height === 180 && Math.abs(r.duration - 8) < 0.35 && r.frames >= 150 && r.audioBytes > 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${JSON.stringify(r)}`);
  }
} finally {
  await chrome.close();
  server.close();
}
console.log(failed ? `\n${failed} nieudanych` : '\nWszystkie warianty odtwarzają się poprawnie');
process.exit(failed ? 1 : 0);
