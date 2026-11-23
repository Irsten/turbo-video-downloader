// Tests of the download engine (lib/engine.js) on a local server with injected errors.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, state, resetCounters, assets, liveReset, liveState, DATA, SIZE, SEGMENTS, segment } from './server.mjs';
import {
  downloadFile,
  downloadHls,
  downloadDash,
  resumableBytes,
  NotMediaError,
  HttpError,
  ENCRYPTED_MSG
} from '../lib/engine.js';
import { MemoryFile } from '../lib/store.js';

let server;
let base;
before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const bytes = async (file) => Buffer.from(await (await file.blob()).arrayBuffer());
const opts = (extra = {}) => ({ connections: 6, retries: 1, fetchInit: {}, ...extra });
const concat = (names) => Buffer.concat(names.map(segment));
const segNames = (dir, ext, n = SEGMENTS) => Array.from({ length: n }, (_, i) => `${dir}/seg${i}.${ext}`);
// The server runs in the same process: let it handle late requests from the interrupted attempt.
const settle = () => new Promise((r) => setTimeout(r, 300));
/** Resume state after a "browser restart" – through JSON, as in chrome.storage. */
const persist = (resume) => JSON.parse(JSON.stringify(resume));

/** Working files in memory; the same map survives the "restart". */
function files() {
  const map = new Map();
  const open = async (role) => {
    if (!map.has(role)) map.set(role, new MemoryFile());
    return map.get(role);
  };
  return { open, map, data: async (role) => bytes(map.get(role)) };
}
/** Assembled parts of a track (as when saving without merging into MP4). */
async function trackBytes(fs, result, role) {
  const t = result.tracks.find((x) => x.role === role);
  const all = await bytes(fs.map.get(role));
  return Buffer.concat(t.parts.map(([pos, size]) => all.subarray(pos, pos + size)));
}

// ---------------- files ----------------

test('many connections: file written byte for byte', async () => {
  const file = new MemoryFile();
  const r = await downloadFile(`${base}/ok.mp4`, opts({ file }));
  assert.equal(r.ranged, true);
  assert.equal(r.size, SIZE);
  assert.ok((await bytes(file)).equals(DATA));
});

test('server without Range: a single connection', async () => {
  const file = new MemoryFile();
  const r = await downloadFile(`${base}/norange.mp4`, opts({ file }));
  assert.equal(r.ranged, false);
  assert.ok((await bytes(file)).equals(DATA));
});

test('HTML page instead of the video => NotMediaError, no retries', async () => {
  resetCounters();
  const t = Date.now();
  await assert.rejects(downloadFile(`${base}/expired.mp4`, opts({ file: new MemoryFile(), retries: 6 })), (e) => {
    assert.ok(e instanceof NotMediaError, e.message);
    assert.match(e.message, /web page instead of the video/);
    return true;
  });
  assert.ok(Date.now() - t < 1500, 'no waiting for retries');
  assert.ok(state.requests['/expired.mp4'] <= 2, `requests: ${state.requests['/expired.mp4']}`);
});

test('video sent as text/html (PHP script) still downloads', async () => {
  const file = new MemoryFile();
  await downloadFile(`${base}/php.mp4`, opts({ file }));
  assert.ok((await bytes(file)).equals(DATA));
});

test('403 on chunks: a quick error with a hint', async () => {
  const t = Date.now();
  await assert.rejects(downloadFile(`${base}/forbid.mp4`, opts({ file: new MemoryFile(), retries: 6 })), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 403);
    assert.match(e.message, /Access denied \(HTTP 403\).*Reload the page/);
    return true;
  });
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('resume after a "restart": state from JSON + data from the file, fetches only the missing bytes', async () => {
  resetCounters();
  state.flakyBudget = 7 * 1024 * 1024;
  const file = new MemoryFile();
  const resume = {};
  try {
    await assert.rejects(downloadFile(`${base}/flaky.mp4`, opts({ file, resume })), HttpError);
  } finally {
    await settle();
    state.flakyBudget = Infinity;
  }
  const saved = persist(resume);
  const kept = resumableBytes(saved);
  assert.ok(kept > 0 && kept < SIZE, `kept ${kept}`);

  resetCounters();
  const events = [];
  await downloadFile(`${base}/flaky.mp4`, opts({ file, resume: saved, onProgress: (p) => events.push({ ...p }) }));
  assert.ok((await bytes(file)).equals(DATA), 'identical content');
  const i = events.findIndex((p) => p.resumed);
  assert.ok(i >= 0, 'there is a resume event');
  assert.equal(events[i].loaded, kept);
  const fetched = state.served['/flaky.mp4'] - 1; // minus the 1 byte of the probe
  assert.ok(fetched >= SIZE - kept && fetched < SIZE, `kept ${kept} B, the second attempt fetched ${fetched} B`);
});

test('cancel and resume (pause)', async () => {
  state.slow = true;
  try {
    const file = new MemoryFile();
    const resume = {};
    const ctrl = new AbortController();
    await assert.rejects(
      downloadFile(`${base}/ok.mp4`, opts({ file, resume, signal: ctrl.signal, onProgress: (p) => p.loaded > 5e6 && ctrl.abort() })),
      (e) => e.name === 'AbortError'
    );
    const kept = resumableBytes(resume);
    assert.ok(kept > 4.5e6 && kept < SIZE, `kept ${kept} (pause writes everything that arrived)`);
    state.slow = false;
    await downloadFile(`${base}/ok.mp4`, opts({ file, resume: persist(resume) }));
    assert.ok((await bytes(file)).equals(DATA));
  } finally {
    state.slow = false;
  }
});

test('different file size on resume => start from scratch', async () => {
  const file = new MemoryFile();
  await file.write(0, new Uint8Array(50));
  const resume = { url: `${base}/ok.mp4`, total: 123, chunks: [{ start: 0, end: 122, received: 50 }] };
  await downloadFile(`${base}/ok.mp4`, opts({ file, resume }));
  assert.ok((await bytes(file)).equals(DATA));
  assert.equal(resume.total, SIZE);
});

// ---------------- HLS ----------------

test('HLS: master + osobne audio', async () => {
  const fs = files();
  const r = await downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, openFile: fs.open }));
  assert.ok((await trackBytes(fs, r, 'video')).equals(concat(segNames('v720', 'ts'))));
  assert.ok((await trackBytes(fs, r, 'audio')).equals(concat(segNames('a', 'aac'))));
  assert.deepEqual(r.tracks.map((t) => t.ext), ['ts', 'aac']);
});

test('HLS: resume after a segment error (state through JSON)', async () => {
  state.failSegments.set('v720/seg15.ts', 404);
  const fs = files();
  const resume = {};
  try {
    await assert.rejects(downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, resume, openFile: fs.open })), HttpError);
  } finally {
    await settle();
    state.failSegments.clear();
  }
  const saved = persist(resume);
  assert.ok(resumableBytes(saved) > 0, 'something was kept');

  resetCounters();
  let first = null;
  const r = await downloadHls(
    `${base}/hls/master.m3u8`,
    opts({ concurrency: 4, resume: saved, openFile: fs.open, onProgress: (p) => (first ??= p) })
  );
  assert.ok((await trackBytes(fs, r, 'video')).equals(concat(segNames('v720', 'ts'))));
  assert.ok((await trackBytes(fs, r, 'audio')).equals(concat(segNames('a', 'aac'))));
  assert.equal(first.resumed, true);
  const segReq = Object.keys(state.requests).filter((k) => /seg\d+/.test(k)).length;
  assert.ok(segReq < SEGMENTS * 2, `fetched again ${segReq} of ${SEGMENTS * 2} segments`);
});

test('HLS: segment as an HTML page => NotMediaError', async () => {
  state.failSegments.set('v720/seg3.ts', 'html');
  try {
    await assert.rejects(
      downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, retries: 6, openFile: files().open })),
      NotMediaError
    );
  } finally {
    state.failSegments.clear();
  }
});

test('HLS: playlist as a sign-in page => NotMediaError', async () => {
  await assert.rejects(downloadHls(`${base}/hls/login.m3u8`, opts({ openFile: files().open })), NotMediaError);
});

test('HLS: a 403 segment fails quickly', async () => {
  state.failSegments.set('v720/seg2.ts', 403);
  const t = Date.now();
  try {
    await assert.rejects(
      downloadHls(`${base}/hls/master.m3u8`, opts({ concurrency: 4, retries: 6, openFile: files().open })),
      (e) => e.status === 403
    );
  } finally {
    state.failSegments.clear();
  }
  assert.ok(Date.now() - t < 3000);
});

test('HLS: choice of audio track (language) and subtitles', async () => {
  const pl = (dir, ext, n) =>
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' + Array.from({ length: n }, (_, i) => `#EXTINF:4,\n${dir}/seg${i}.${ext}\n`).join('') + '#EXT-X-ENDLIST\n';
  const m3u8 = 'application/vnd.apple.mpegurl';
  assets['/h2/master.m3u8'] = {
    type: m3u8,
    body:
      '#EXTM3U\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Polski",LANGUAGE="pl",DEFAULT=YES,URI="pl.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="en.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Polskie",LANGUAGE="pl",URI="subs.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="a",SUBTITLES="s"\nv.m3u8\n'
  };
  assets['/h2/v.m3u8'] = { type: m3u8, body: pl('v', 'ts', 3) };
  assets['/h2/pl.m3u8'] = { type: m3u8, body: pl('pl', 'aac', 3) };
  assets['/h2/en.m3u8'] = { type: m3u8, body: pl('en', 'aac', 3) };
  assets['/h2/subs.m3u8'] = { type: m3u8, body: pl('s', 'vtt', 2) };
  for (const d of ['v', 'pl', 'en']) for (let i = 0; i < 3; i++) assets[`/h2/${d}/seg${i}.${d === 'v' ? 'ts' : 'aac'}`] = { body: segment(`h2/${d}/${i}`) };
  for (let i = 0; i < 2; i++) assets[`/h2/s/seg${i}.vtt`] = { type: 'text/vtt', body: `WEBVTT\n\n00:00:0${i}.000 --> 00:00:0${i}.900\nNapis ${i}\n` };

  const fs = files();
  const r = await downloadHls(
    `${base}/h2/master.m3u8`,
    opts({
      openFile: fs.open,
      audioUrl: `${base}/h2/en.m3u8`,
      subtitles: [{ url: `${base}/h2/subs.m3u8`, name: 'Polskie', language: 'pl' }]
    })
  );
  assert.equal(r.audioTrack.language, 'en');
  const expected = Buffer.concat([0, 1, 2].map((i) => segment(`h2/en/${i}`)));
  assert.ok((await trackBytes(fs, r, 'audio')).equals(expected), 'the English track was downloaded');
  assert.equal(r.subtitles.length, 1);
  assert.equal(r.subtitles[0].language, 'pl');
  assert.equal(r.subtitles[0].segments.length, 2);
  assert.match(r.subtitles[0].segments[1], /Napis 1/);
});

test('HLS live: recording until stopped – segments in order, no gaps or repeats', async () => {
  liveReset({ step: 400 });
  const fs = files();
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 2600);
  const t = Date.now();
  const r = await downloadHls(`${base}/live/index.m3u8`, opts({ openFile: fs.open, record: true, stopSignal: stop.signal, concurrency: 2 }));
  assert.ok(Date.now() - t < 6000, 'stopped after stop');
  assert.equal(r.live, true);
  const parts = r.tracks[0].parts;
  assert.ok(parts.length >= 5, `recorded ${parts.length} segments`);
  const data = await trackBytes(fs, r, 'video');
  const expected = Buffer.concat(parts.map((_, i) => liveState.segments(i)));
  assert.ok(data.equals(expected), 'consecutive segments 0..n in the right order');
  assert.ok(Math.abs(r.duration - parts.length * 0.4) < 0.01, `recording length ${r.duration}`);
});

test('HLS live: the end of the stream (ENDLIST) ends recording by itself', async () => {
  liveReset({ step: 300 });
  setTimeout(() => (liveState.ended = true), 1200);
  const fs = files();
  const r = await downloadHls(`${base}/live/index.m3u8`, opts({ openFile: fs.open, record: true, concurrency: 2 }));
  assert.ok(r.tracks[0].parts.length >= 4, `recorded ${r.tracks[0].parts.length}`);
});

// ---------------- DASH ----------------

function dashAssets() {
  for (const k of ['v', 'a']) {
    assets[`/dash/${k}/init.mp4`] = { body: segment(`dash/${k}/init`) };
    for (let i = 1; i <= 4; i++) assets[`/dash/${k}/seg-${i}.m4s`] = { body: segment(`dash/${k}/${i}`) };
  }
  assets['/dash/subs.vtt'] = { type: 'text/vtt', body: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n' };
  const mpd = (extra = '') => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">${extra}
      <SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="2" startNumber="1"/>
      <Representation id="lo" bandwidth="300000" width="320" height="180"/>
      <Representation id="v" bandwidth="900000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="pl">
      <SegmentTemplate media="$RepresentationID$/seg-$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="2"/>
      <Representation id="a" bandwidth="96000"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="pl">
      <Representation id="sub-pl" bandwidth="100"><BaseURL>subs.vtt</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  assets['/dash/manifest.mpd'] = { type: 'application/dash+xml', body: mpd() };
  assets['/dash/drm.mpd'] = {
    type: 'application/dash+xml',
    body: mpd('<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>')
  };
  assets['/dash/single.mpd'] = {
    type: 'application/dash+xml',
    body: `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
      <AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" height="720"><BaseURL>../ok.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation></AdaptationSet>
    </Period></MPD>`
  };
}

test('DASH: SegmentTemplate – chosen quality, audio, subtitles', async () => {
  dashAssets();
  const fs = files();
  const r = await downloadDash(`${base}/dash/manifest.mpd`, opts({ openFile: fs.open, videoId: 'v', textIds: ['sub-pl'] }));
  const exp = (k) => Buffer.concat([segment(`dash/${k}/init`), ...[1, 2, 3, 4].map((i) => segment(`dash/${k}/${i}`))]);
  assert.ok((await trackBytes(fs, r, 'video')).equals(exp('v')), 'video: init + 4 segments of quality "v"');
  assert.ok((await trackBytes(fs, r, 'audio')).equals(exp('a')));
  assert.deepEqual(r.tracks.map((t) => t.ext), ['mp4', 'm4a']);
  assert.equal(r.subtitles.length, 1);
  assert.match(r.subtitles[0].vtt, /Hello/);
});

test('DASH: whole file (SegmentBase) downloaded over many connections', async () => {
  dashAssets();
  const fs = files();
  const r = await downloadDash(`${base}/dash/single.mpd`, opts({ openFile: fs.open }));
  assert.equal(r.tracks.length, 1);
  assert.ok((await trackBytes(fs, r, 'video')).equals(DATA));
});

test('DASH with DRM is rejected', async () => {
  dashAssets();
  await assert.rejects(downloadDash(`${base}/dash/drm.mpd`, opts({ openFile: files().open })), (e) => e.message === ENCRYPTED_MSG);
});
