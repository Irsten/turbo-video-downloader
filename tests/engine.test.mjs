// Testy silnika pobierania (lib/engine.js) na lokalnym serwerze z wstrzykiwanymi błędami.
// Uruchom: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, state, resetCounters, DATA, SIZE, SEGMENTS, segment } from './server.mjs';
import { downloadFile, downloadHls, resumableBytes, NotMediaError, HttpError } from '../lib/engine.js';

let server;
let base;
before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const bytes = async (blob) => Buffer.from(await blob.arrayBuffer());
const opts = (extra = {}) => ({ connections: 6, retries: 1, fetchInit: {}, ...extra });
const concat = (names) => Buffer.concat(names.map(segment));
const segNames = (dir, ext) => Array.from({ length: SEGMENTS }, (_, i) => `${dir}/seg${i}.${ext}`);
// Serwer działa w tym samym procesie: niech obsłuży spóźnione żądania z przerwanej próby,
// zanim wyzerujemy liczniki.
const settle = () => new Promise((r) => setTimeout(r, 300));

// ---------------- pliki ----------------

test('wiele połączeń: plik złożony bajt w bajt', async () => {
  const r = await downloadFile(`${base}/ok.mp4`, opts());
  assert.equal(r.ranged, true);
  assert.equal(r.size, SIZE);
  assert.ok((await bytes(r.blob)).equals(DATA));
});

test('serwer bez Range: jedno połączenie', async () => {
  const r = await downloadFile(`${base}/norange.mp4`, opts());
  assert.equal(r.ranged, false);
  assert.ok((await bytes(r.blob)).equals(DATA));
});

test('strona HTML zamiast filmu => NotMediaError, bez ponawiania', async () => {
  resetCounters();
  const t = Date.now();
  await assert.rejects(downloadFile(`${base}/expired.mp4`, opts({ retries: 6 })), (e) => {
    assert.ok(e instanceof NotMediaError, e.message);
    assert.match(e.message, /stronę WWW/);
    return true;
  });
  assert.ok(Date.now() - t < 1500, 'bez czekania na ponowienia');
  assert.ok(state.requests['/expired.mp4'] <= 2, `żądań: ${state.requests['/expired.mp4']}`);
});

test('film wysłany jako text/html (skrypt PHP) nadal się pobiera', async () => {
  const r = await downloadFile(`${base}/php.mp4`, opts());
  assert.ok((await bytes(r.blob)).equals(DATA));
});

test('403 przy fragmentach: szybki błąd z podpowiedzią', async () => {
  const t = Date.now();
  await assert.rejects(downloadFile(`${base}/forbid.mp4`, opts({ retries: 6 })), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 403);
    assert.match(e.message, /Brak dostępu \(HTTP 403\).*Odśwież stronę/);
    return true;
  });
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `trwało ${ms} ms`);
});

test('wznawianie po błędzie: dociąga tylko brakujące bajty', async () => {
  resetCounters();
  state.flakyBudget = 7 * 1024 * 1024;
  const resume = {};
  try {
    await assert.rejects(downloadFile(`${base}/flaky.mp4`, opts({ resume })), HttpError);
  } finally {
    await settle();
    state.flakyBudget = Infinity;
  }
  const kept = resumableBytes(resume);
  assert.ok(kept > 0 && kept < SIZE, `zachowano ${kept}`);

  resetCounters();
  const events = [];
  const r = await downloadFile(`${base}/flaky.mp4`, opts({ resume, onProgress: (p) => events.push({ ...p }) }));
  assert.ok((await bytes(r.blob)).equals(DATA), 'treść identyczna');
  const i = events.findIndex((p) => p.resumed);
  assert.ok(i >= 0, 'jest zdarzenie wznowienia');
  assert.equal(events[i].loaded, kept);
  assert.ok(events.slice(0, i).every((p) => p.loaded === 0), 'przed wznowieniem nic nie pobrano');
  // Serwer liczy całe wysłane odpowiedzi; przy dzieleniu fragmentów w locie może wysłać trochę
  // więcej, niż klient przeczyta – ważne, że nie pobieramy całości od nowa.
  const fetched = state.served['/flaky.mp4'] - 1; // minus 1 bajt sondy
  assert.ok(fetched >= SIZE - kept && fetched < SIZE, `zachowano ${kept} B, druga próba pobrała ${fetched} B`);
});

test('anulowanie i wznowienie (pauza)', async () => {
  state.slow = true;
  try {
    const resume = {};
    const ctrl = new AbortController();
    await assert.rejects(
      downloadFile(`${base}/ok.mp4`, opts({ resume, signal: ctrl.signal, onProgress: (p) => p.loaded > 5e6 && ctrl.abort() })),
      (e) => e.name === 'AbortError'
    );
    const kept = resumableBytes(resume);
    assert.ok(kept > 5e6 && kept < SIZE, `zachowano ${kept}`);
    state.slow = false;
    const r = await downloadFile(`${base}/ok.mp4`, opts({ resume }));
    assert.ok((await bytes(r.blob)).equals(DATA));
  } finally {
    state.slow = false;
  }
});

test('inny rozmiar pliku przy ponowieniu => start od zera', async () => {
  const resume = { url: `${base}/ok.mp4`, total: 123, chunks: [{ start: 0, end: 122, received: 5, col: null }] };
  const r = await downloadFile(`${base}/ok.mp4`, opts({ resume }));
  assert.ok((await bytes(r.blob)).equals(DATA));
  assert.equal(resume.total, SIZE);
});

// ---------------- HLS ----------------

test('HLS: master + osobne audio', async () => {
  const r = await downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4 }));
  assert.ok((await bytes(r.video.blob)).equals(concat(segNames('v720', 'ts'))));
  assert.ok((await bytes(r.audio.blob)).equals(concat(segNames('a', 'aac'))));
});

test('HLS: wznawianie po błędzie segmentu', async () => {
  state.failSegments.set('v720/seg15.ts', 404);
  const resume = {};
  try {
    await assert.rejects(downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, resume })), HttpError);
  } finally {
    await settle();
    state.failSegments.clear();
  }
  assert.ok(resumableBytes(resume) > 0, 'coś zachowano');

  resetCounters();
  let first = null;
  const r = await downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, resume, onProgress: (p) => (first ??= p) }));
  assert.ok((await bytes(r.video.blob)).equals(concat(segNames('v720', 'ts'))));
  assert.ok((await bytes(r.audio.blob)).equals(concat(segNames('a', 'aac'))));
  assert.equal(first.resumed, true);
  const segReq = Object.keys(state.requests).filter((k) => /seg\d+/.test(k)).length;
  assert.ok(segReq < SEGMENTS * 2, `ponownie pobrano ${segReq} segmentów z ${SEGMENTS * 2}`);
});

test('HLS: segment jako strona HTML => NotMediaError', async () => {
  state.failSegments.set('v720/seg3.ts', 'html');
  try {
    await assert.rejects(downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, retries: 6 })), NotMediaError);
  } finally {
    state.failSegments.clear();
  }
});

test('HLS: playlista jako strona logowania => NotMediaError', async () => {
  await assert.rejects(downloadHls(`${base}/hls/login.m3u8`, opts()), NotMediaError);
});

test('HLS: 403 segmentu kończy się szybko', async () => {
  state.failSegments.set('v720/seg2.ts', 403);
  const t = Date.now();
  try {
    await assert.rejects(downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, retries: 6 })), (e) => e.status === 403);
  } finally {
    state.failSegments.clear();
  }
  assert.ok(Date.now() - t < 3000);
});
