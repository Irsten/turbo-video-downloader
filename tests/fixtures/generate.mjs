// Generuje nagrania testowe przy pomocy Chrome (WebCodecs + MediaRecorder) – bez ffmpeg.
// Wynik trafia do tests/fixtures/ i jest częścią repozytorium; uruchamiaj tylko, gdy trzeba
// go odtworzyć:  node tests/fixtures/generate.mjs
//
//   video.h264 + video.json – H.264 (Annex B), 320×180, 25 kl/s, klatka kluczowa co 2 s
//   audio.adts + audio.json – AAC-LC w ramkach ADTS, 48 kHz stereo
//   rec-video.mp4, rec-audio.mp4 – pofragmentowane MP4 z MediaRecorder (niezależny muxer)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, waitFor } from '../cdp.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const SECONDS = 8;

const PAGE = `<!doctype html><meta charset="utf-8"><title>fixtures</title><script>
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const W = 320, H = 180, FPS = 25, SR = 48000, SECONDS = ${SECONDS};
function draw(ctx, i) {
  ctx.fillStyle = 'hsl(' + ((i * 9) % 360) + ' 60% 35%)'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 64px sans-serif'; ctx.fillText(String(i), 24, 120);
  ctx.fillRect((i * 6) % W, 150, 30, 20);
}
const tone = (t) => 0.2 * Math.sin(2 * Math.PI * (330 + 110 * Math.floor(t)) * t);

async function encode() {
  const video = [];
  const venc = new VideoEncoder({
    output: (c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); video.push({ key: c.type === 'key', pts: c.timestamp, data: d }); },
    error: (e) => { throw e; }
  });
  venc.configure({ codec: 'avc1.42001f', width: W, height: H, bitrate: 200000, framerate: FPS, avc: { format: 'annexb' } });
  const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext('2d');
  for (let i = 0; i < FPS * SECONDS; i++) {
    draw(ctx, i);
    const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(f, { keyFrame: i % (FPS * 2) === 0 }); f.close();
  }
  await venc.flush();

  const audio = [];
  const aenc = new AudioEncoder({
    output: (c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); audio.push({ pts: c.timestamp, data: d }); },
    error: (e) => { throw e; }
  });
  aenc.configure({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 96000, aac: { format: 'adts' } });
  for (let s = 0; s < SR * SECONDS; s += 1024) {
    const n = Math.min(1024, SR * SECONDS - s); const data = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) data[k] = data[n + k] = tone((s + k) / SR);
    const a = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((s * 1e6) / SR), data });
    aenc.encode(a); a.close();
  }
  await aenc.flush();
  const pack = (list) => {
    const total = list.reduce((n, x) => n + x.data.length, 0); const all = new Uint8Array(total); let o = 0;
    const meta = list.map((x) => { all.set(x.data, o); o += x.data.length; const { data, ...m } = x; return { ...m, size: data.length }; });
    return { meta, data: b64(all) };
  };
  return { video: pack(video), audio: pack(audio) };
}

async function record() {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'); let i = 0; draw(ctx, 0);
  const timer = setInterval(() => draw(ctx, ++i), 1000 / FPS);
  const ac = new AudioContext({ sampleRate: SR });
  const osc = ac.createOscillator(); osc.frequency.value = 440; const dest = ac.createMediaStreamDestination();
  osc.connect(dest); osc.start();
  const rec = (stream, mime, opts) => new Promise((resolve) => {
    const r = new MediaRecorder(stream, { mimeType: mime, ...opts }); const parts = [];
    r.ondataavailable = (e) => e.data.size && parts.push(e.data);
    r.onstop = async () => resolve(b64(new Uint8Array(await new Blob(parts).arrayBuffer())));
    r.start(2000); setTimeout(() => r.stop(), SECONDS * 1000);
  });
  const [v, a] = await Promise.all([
    rec(canvas.captureStream(FPS), 'video/mp4;codecs=avc1.42E01E', { videoBitsPerSecond: 200000 }),
    rec(dest.stream, 'audio/mp4;codecs=mp4a.40.2', { audioBitsPerSecond: 96000 })
  ]);
  clearInterval(timer); osc.stop(); ac.close();
  return { v, a };
}
</script>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const chrome = await launchChrome();
try {
  const t = await chrome.openTarget(`http://127.0.0.1:${server.address().port}/`);
  await waitFor(() => chrome.evaluate(t.sessionId, `typeof encode === 'function' && document.readyState === 'complete'`));
  const enc = await chrome.evaluate(t.sessionId, 'encode()');
  fs.writeFileSync(path.join(OUT, 'video.h264'), Buffer.from(enc.video.data, 'base64'));
  fs.writeFileSync(path.join(OUT, 'video.json'), JSON.stringify(enc.video.meta));
  fs.writeFileSync(path.join(OUT, 'audio.adts'), Buffer.from(enc.audio.data, 'base64'));
  fs.writeFileSync(path.join(OUT, 'audio.json'), JSON.stringify(enc.audio.meta));
  console.log(`WebCodecs: ${enc.video.meta.length} klatek, ${enc.audio.meta.length} ramek AAC`);

  const rec = await chrome.evaluate(t.sessionId, 'record()');
  fs.writeFileSync(path.join(OUT, 'rec-video.mp4'), Buffer.from(rec.v, 'base64'));
  fs.writeFileSync(path.join(OUT, 'rec-audio.mp4'), Buffer.from(rec.a, 'base64'));
  console.log('MediaRecorder: rec-video.mp4, rec-audio.mp4');
} finally {
  await chrome.close();
  server.close();
}
