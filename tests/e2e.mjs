// Extension test in a real Chrome: loads the extension into a temporary profile
// (CDP over a pipe + Extensions.loadUnpacked, Chrome 126+) and checks on local pages:
// detection and badge, SPA, popup, content.js, manager (errors, resuming also after closing it),
// merging into MP4 (played in Chrome), .srt subtitles, DASH, audio choice, live recording,
// YouTube through the helper program with a fake yt-dlp (personal build),
//
// Run: npm run test:e2e
//   CHROME=path      – a different Chrome/Chromium (searched in the usual places by default)
//   HEADFUL=1        – show the browser window
//   KEEP=1           – keep the profile and the downloaded files (the path is printed)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, waitFor, sleep } from './cdp.mjs';
import { startServer, pages, assets, state, resetCounters, liveReset, liveState, DATA, SIZE } from './server.mjs';
import { loadFixtures, buildTs, splitFmp4, mediaPlaylist, vttSegments, vttFile, CUES } from './media.mjs';

const EXT_ROOT = process.env.EXT_ROOT || fileURLToPath(new URL('..', import.meta.url));
const fx = loadFixtures();
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- test material
const M3U8 = 'application/vnd.apple.mpegurl';
function mediaAssets() {
  // HLS TS (video + audio) with WebVTT subtitles
  const cc = { v: { cc: 0 }, a: { cc: 0 }, psi: 0 };
  for (let i = 0; i < 4; i++) assets[`/m/ts/seg${i}.ts`] = { type: 'video/mp2t', body: buildTs(fx, i * 2, i * 2 + 2, { cc }) };
  assets['/m/ts/v.m3u8'] = { type: M3U8, body: mediaPlaylist([0, 1, 2, 3].map((i) => ({ uri: `seg${i}.ts`, dur: 2 }))) };
  vttSegments().forEach((v, i) => (assets[`/m/ts/sub${i}.vtt`] = { type: 'text/vtt', body: v }));
  assets['/m/ts/subs.m3u8'] = { type: M3U8, body: mediaPlaylist([0, 1, 2, 3].map((i) => ({ uri: `sub${i}.vtt`, dur: 2 }))) };
  assets['/m/ts/master.m3u8'] = {
    type: M3U8,
    body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Polish",LANGUAGE="pl",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,SUBTITLES="s"\nv.m3u8\n'
  };

  // HLS fMP4 with two audio tracks (pl / en)
  const v = splitFmp4(fx.recVideo);
  const a = splitFmp4(fx.recAudio);
  assets['/m/f/v-init.mp4'] = { body: v.init };
  v.fragments.forEach((f, i) => (assets[`/m/f/v${i}.m4s`] = { body: f }));
  assets['/m/f/v.m3u8'] = { type: M3U8, body: mediaPlaylist(v.fragments.map((_, i) => ({ uri: `v${i}.m4s`, dur: v.durations[i] })), { map: 'v-init.mp4' }) };
  for (const lang of ['pl', 'en']) {
    assets[`/m/f/${lang}-init.mp4`] = { body: a.init };
    a.fragments.forEach((f, i) => (assets[`/m/f/${lang}${i}.m4s`] = { body: f }));
    assets[`/m/f/${lang}.m3u8`] = {
      type: M3U8,
      body: mediaPlaylist(a.fragments.map((_, i) => ({ uri: `${lang}${i}.m4s`, dur: a.durations[i] })), { map: `${lang}-init.mp4` })
    };
  }
  assets['/m/f/master.m3u8'] = {
    type: M3U8,
    body:
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Polish",LANGUAGE="pl",DEFAULT=YES,URI="pl.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="en.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,AUDIO="a"\nv.m3u8\n'
  };

  // DASH: SegmentTemplate + SegmentTimeline, WebVTT subtitles
  const timeline = (s) => s.times.map((t, i) => `<S t="${t}" d="${Math.round(s.durations[i] * s.timescale)}"/>`).join('');
  for (const [k, s] of [['v', v], ['a', a]]) {
    assets[`/m/d/${k}/init.mp4`] = { body: s.init };
    s.fragments.forEach((f, i) => (assets[`/m/d/${k}/${i + 1}.m4s`] = { body: f }));
  }
  assets['/m/d/pl.vtt'] = { type: 'text/vtt', body: vttFile() };
  assets['/m/d/manifest.mpd'] = {
    type: 'application/dash+xml',
    body: `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S"><Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate timescale="${v.timescale}" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4" startNumber="1"><SegmentTimeline>${timeline(v)}</SegmentTimeline></SegmentTemplate>
        <Representation id="v" bandwidth="200000" width="320" height="180"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="pl">
        <SegmentTemplate timescale="${a.timescale}" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4" startNumber="1"><SegmentTimeline>${timeline(a)}</SegmentTimeline></SegmentTemplate>
        <Representation id="a" bandwidth="96000"/>
      </AdaptationSet>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="pl"><Representation id="t" bandwidth="1"><BaseURL>pl.vtt</BaseURL></Representation></AdaptationSet>
    </Period></MPD>`
  };

  // Live stream: consecutive TS segments with a continuous timeline.
  const liveCache = new Map();
  const liveCc = { v: { cc: 0 }, a: { cc: 0 }, psi: 0 };
  liveState.segments = (n) => {
    if (!liveCache.has(n)) liveCache.set(n, buildTs(fx, (n % 4) * 2, (n % 4) * 2 + 2, { shift: n * 2 - (n % 4) * 2, cc: liveCc }));
    return liveCache.get(n);
  };
  assets['/big.mp4'] = { type: 'video/mp4', body: DATA };
  assets['/m/ctx.mp4'] = { type: 'video/mp4', body: DATA };
  assets['/m/clip.mp4'] = { type: 'video/mp4', body: fx.recVideo };
  assets['/m/poster.png'] = { type: 'image/png', body: fs.readFileSync(path.join(EXT_ROOT, 'icons', 'icon128.png')) };
}

const fetcher = (urls) => `<script>(async () => { for (const u of ${JSON.stringify(urls)}) await (await fetch(u)).text(); })();</script>`;
pages['/p/hls.html'] = `<!doctype html><title>HLS video</title><meta property="og:image" content="/m/poster.png">${fetcher(['/m/ts/master.m3u8', '/m/ts/v.m3u8'])}`;
pages['/p/fmp4.html'] = `<!doctype html><title>fMP4 video</title>${fetcher(['/m/f/master.m3u8', '/m/f/v.m3u8', '/m/f/pl.m3u8'])}`;
pages['/p/dash.html'] = `<!doctype html><title>DASH video</title>${fetcher(['/m/d/manifest.mpd'])}`;
pages['/p/live.html'] = `<!doctype html><title>Live stream</title>${fetcher(['/live/index.m3u8'])}`;
pages['/p/track.html'] = `<!doctype html><title>Video with subtitles</title>
  <video src="/m/clip.mp4" poster="/m/poster.png" preload="metadata" muted><track src="/m/d/pl.vtt" kind="subtitles" srclang="pl" label="Polish"></video>`;
pages['/player.html'] = `<!doctype html><title>player</title><body><script>
window.check = async (src) => {
  const v = document.createElement('video'); v.muted = true; v.src = src; document.body.append(v);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('load error: ' + (v.error && v.error.message))); setTimeout(() => rej(new Error('did not load within 10 s')), 10000); });
  const info = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  v.playbackRate = 4; await Promise.race([v.play(), new Promise((r) => setTimeout(r, 5000))]);
  await Promise.race([new Promise((r) => (v.onended = r)), new Promise((r) => setTimeout(r, 15000))]);
  Object.assign(info, { ended: v.ended, frames: v.getVideoPlaybackQuality().totalVideoFrames, audioBytes: v.webkitAudioDecodedByteCount });
  v.remove(); return info;
};</script>`;

// ---------------------------------------------------------------- start
const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
mediaAssets();
const chrome = await launchChrome();
const { send, evaluate, openTarget } = chrome;
const downloaded = (prefix, ext) =>
  fs.readdirSync(chrome.downloads).find((f) => f.startsWith(prefix) && (!ext || f.endsWith(ext)) && !f.endsWith('.crdownload'));

/** Plays a file from the downloads folder in Chrome and returns playback stats. */
let player = null;
async function play(name, dir = chrome.downloads) {
  const route = '/dl/' + encodeURIComponent(name);
  assets[route] = { type: 'video/mp4', body: () => fs.readFileSync(path.join(dir, name)) };
  if (!player) {
    player = await openTarget(`${base}/player.html`);
    await waitFor(() => evaluate(player.sessionId, `typeof window.check === 'function'`));
  }
  // Chrome pauses muted videos in background tabs – the player has to be in front.
  await send('Page.bringToFront', {}, player.sessionId);
  return evaluate(player.sessionId, `check(${JSON.stringify(route)})`).catch((e) => ({ error: e.message }));
}
const playsWell = (r, minDur = 7.5) =>
  r && !r.error && r.ended && r.width === 320 && r.height === 180 && r.duration > minDur && r.frames > 0 && r.audioBytes > 0;

try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT_ROOT });
  console.log('extension:', extId);

  const swTarget = await waitFor(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
  });
  const { sessionId: sw } = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  await evaluate(sw, '1');

  const tabOf = (part) => waitFor(() => evaluate(sw, `chrome.tabs.query({}).then(ts => ts.find(t => t.url?.includes(${JSON.stringify(part)})))`));
  const badgeOf = (tabId) => evaluate(sw, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  const storedOf = (tabId) => evaluate(sw, `chrome.storage.session.get('tab:${tabId}').then(o => Object.values(o['tab:${tabId}'] || {}))`);

  /** Popup for a tab (the popup takes the active tab – we substitute the test one). */
  async function openPopup(tabObj) {
    const p = await openTarget('about:blank');
    await send('Page.enable', {}, p.sessionId);
    await send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: `if (location.protocol === 'chrome-extension:') chrome.tabs.query = async () => [${JSON.stringify(tabObj)}];` },
      p.sessionId
    );
    await send('Page.navigate', { url: `chrome-extension://${extId}/popup.html` }, p.sessionId);
    return p;
  }
  const closeTarget = (t) => send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});

  // ================= A: detection + badge without HLS variants =================
  pages['/video.html'] = `<!doctype html><html><head><meta charset="utf-8"><title>Test video A</title></head><body>
    <video id="v" src="/ok.mp4" preload="auto" muted></video>
    <a id="link" href="/nic.html">link</a><div id="feed"></div>
    <script>
      fetch('/hls/master.m3u8').then(r => r.text())
        .then(() => fetch('/hls/v720.m3u8')).then(r => r.text())
        .then(() => fetch('/hls/audio.m3u8')).then(r => r.text());
    </script></body></html>`;
  const page = await openTarget(`${base}/video.html`);
  const tabA = await tabOf('/video.html');
  const tabId = tabA.id;
  await waitFor(async () => (await storedOf(tabId)).filter((i) => i.hls).length >= 3, 10000);
  const itemsA = await storedOf(tabId);
  const hlsInfo = itemsA.filter((i) => i.kind === 'hls').map((i) => `${i.url.split('/').pop()}:${i.hls?.kind}`);
  check('detected a file and 3 HLS playlists', itemsA.length === 4, `${itemsA.length} items; ${hlsInfo.join(', ')}`);
  const bA = await waitFor(async () => ((await badgeOf(tabId)) === '2' ? '2' : null), 5000);
  check('badge = 2 (MP4 + master), HLS variants not counted', bA === '2', `badge: "${await badgeOf(tabId)}"`);

  // ================= C: content.js – only new elements =================
  await evaluate(
    page.sessionId,
    `(() => {
      const feed = document.getElementById('feed');
      const a = document.createElement('a'); a.href = '/clip-late.mp4'; a.textContent = 'x'; feed.append(a);
      document.getElementById('link').href = '/clip-attr.webm';
      const box = document.createElement('div');
      box.innerHTML = '<video><source src="/ok.mp4?v=src" type="video/mp4"></video>';
      feed.append(box);
    })()`
  );
  const domOk = await waitFor(async () => {
    const urls = (await storedOf(tabId)).map((i) => i.url);
    return ['/clip-late.mp4', '/clip-attr.webm', '/ok.mp4?v=src'].every((u) => urls.includes(base + u));
  }, 5000);
  check('content.js: new link, changed href and <source> in a new node', !!domOk);
  await evaluate(
    page.sessionId,
    `(() => {
      const feed = document.getElementById('feed');
      for (let i = 0; i < 2500; i++) { const p = document.createElement('p'); p.textContent = i; feed.append(p); }
      const a = document.createElement('a'); a.href = '/clip-mass.mp4'; feed.append(a);
    })()`
  );
  const massOk = await waitFor(async () => (await storedOf(tabId)).some((i) => i.url === base + '/clip-mass.mp4'), 5000);
  check('content.js: massive change (>2000 nodes) → a full scan still detects', !!massOk);
  const bC = await waitFor(async () => ((await badgeOf(tabId)) === '6' ? '6' : null), 5000);
  check('badge = 6 after adding 4 videos from the page', bC === '6', `badge: "${await badgeOf(tabId)}"`);

  // ================= B: SPA =================
  await evaluate(page.sessionId, `history.pushState({}, '', '/video2.html'); document.title = 'Video B'; 1`);
  const bB = await waitFor(async () => ((await badgeOf(tabId)) === '' ? 'empty' : null), 5000);
  check('SPA: after changing the sub-page the badge = 0', bB === 'empty', `badge: "${await badgeOf(tabId)}"`);
  await evaluate(
    page.sessionId,
    `(() => { const v = document.createElement('video'); v.src = '/ok.mp4?v=2'; v.preload = 'auto'; v.muted = true; document.body.append(v); })()`
  );
  const bB2 = await waitFor(async () => ((await badgeOf(tabId)) === '1' ? '1' : null), 6000);
  check('SPA: a new video on the new sub-page → badge = 1', bB2 === '1', `badge: "${await badgeOf(tabId)}"`);

  const popupA = await openPopup(await evaluate(sw, `chrome.tabs.get(${tabId})`));
  const popupState = await waitFor(async () => {
    const s = await evaluate(
      popupA.sessionId,
      `({
        current: [...document.querySelectorAll('#list > .item .fname')].map(e => e.value),
        earlierSummary: document.querySelector('#list > details.earlier > summary')?.textContent || null,
        earlierOpen: document.querySelector('#list > details.earlier')?.open,
        earlier: [...document.querySelectorAll('#list > details.earlier .item .fname')].map(e => e.value),
        hlsMeta: [...document.querySelectorAll('.item')].filter(e => e.querySelector('.badge.hls')).map(e => e.querySelector('.meta').textContent)
      })`
    );
    return s.earlier.length && s.hlsMeta.every((m) => !m.includes('analyzing')) ? s : null;
  }, 8000);
  check('popup: current sub-page = 1 video', popupState?.current.length === 1, JSON.stringify(popupState?.current));
  check(
    'popup: section "Earlier on this tab (6)", collapsed',
    popupState?.earlierSummary === 'Earlier on this tab (6)' && popupState?.earlierOpen === false,
    `${popupState?.earlierSummary}, open=${popupState?.earlierOpen}`
  );
  check(
    'popup: HLS variants hidden (only the master with a quality choice)',
    popupState?.hlsMeta.length === 1 && popupState.hlsMeta[0].includes('2 qualities'),
    JSON.stringify(popupState?.hlsMeta)
  );
  await evaluate(
    popupA.sessionId,
    `(() => { const d = document.querySelector('details.earlier'); d.open = true;
      const item = [...d.querySelectorAll('.item')].find(e => e.querySelector('.src').title.endsWith('/ok.mp4'));
      item.querySelector('.actions button:not(.primary)').click(); })()`
  );
  const named = await waitFor(() => downloaded('Test video A'), 10000);
  check('popup: an earlier video named after the title of its own sub-page', !!named, `file: ${named}`);
  await closeTarget(popupA);

  // ================= D: manager – errors and resuming =================
  let mgr = await openTarget(`chrome-extension://${extId}/manager.html`);
  await waitFor(() => evaluate(mgr.sessionId, `!!document.querySelector('#add-url')`));
  const add = (url) =>
    evaluate(
      mgr.sessionId,
      `(() => { document.querySelector('#add-url').value = ${JSON.stringify(url)};
        document.querySelector('#add-form').requestSubmit(); })()`
    );
  const card = (needle) =>
    evaluate(
      mgr.sessionId,
      `(() => { const c = [...document.querySelectorAll('.job')].find(c => (c.querySelector('.title').title + ' ' + c.querySelector('.title').textContent).includes(${JSON.stringify(needle)}));
        return c && { cls: c.className, status: c.querySelector('.status').textContent, stats: c.querySelector('.stats').textContent,
          buttons: [...c.querySelectorAll('.buttons button')].map(b => b.textContent) }; })()`
    );
  const clickIn = (needle, label) =>
    evaluate(
      mgr.sessionId,
      `[...document.querySelectorAll('.job')].find(c => (c.querySelector('.title').title + ' ' + c.querySelector('.title').textContent).includes(${JSON.stringify(needle)}))
        .querySelectorAll('.buttons button').forEach(b => b.textContent === ${JSON.stringify(label)} && b.click())`
    );
  const until = async (needle, re, timeout) => {
    const c = await waitFor(async () => {
      const x = await card(needle);
      return x && re.test(x.cls) ? x : null;
    }, timeout);
    return c || (await card(needle));
  };

  let t = Date.now();
  await add(`${base}/expired.mp4`);
  const cExp = await until('/expired.mp4', /error/, 10000);
  check('manager: HTML page instead of the video → a clear error', /web page instead of the video/.test(cExp?.status || ''), `${Date.now() - t} ms: ${cExp?.status}`);

  t = Date.now();
  await add(`${base}/forbid.mp4`);
  const cFor = await until('/forbid.mp4', /error/, 15000);
  check('manager: 403 → a quick error with a hint', /Access denied \(HTTP 403\)/.test(cFor?.status || '') && Date.now() - t < 5000, `${Date.now() - t} ms`);

  state.flakyBudget = 7 * 1024 * 1024;
  resetCounters();
  await add(`${base}/flaky.mp4`);
  const cFl = await until('/flaky.mp4', /error/, 15000);
  check(
    'manager: after an error "Resume" and info about the kept data',
    cFl?.buttons.includes('Resume') && /Kept/.test(cFl?.stats || ''),
    `${cFl?.stats} | [${cFl?.buttons}]`
  );
  await sleep(300);
  state.flakyBudget = Infinity;
  resetCounters();
  await clickIn('/flaky.mp4', 'Resume');
  const cDone = await until('/flaky.mp4', /done/, 30000);
  const flakyFile = cDone && (await waitFor(() => downloaded('flaky', '.mp4'), 10000));
  check('manager: "Resume" finishes the download, identical file', flakyFile && fs.readFileSync(path.join(chrome.downloads, flakyFile)).equals(DATA), flakyFile);
  const refetched = (state.served['/flaky.mp4'] || 0) - 1;
  check('manager: resuming does not start from scratch', refetched > 0 && refetched < SIZE, `second time fetched ${refetched} of ${SIZE} B`);

  // ================= E: closing the manager mid-download and resuming =================
  Object.assign(state, { slow: true, slowChunk: 32 * 1024, slowDelay: 25 });
  resetCounters();
  await add(`${base}/big.mp4`);
  const halfway = await waitFor(async () => {
    const all = await evaluate(sw, `chrome.storage.local.get(null)`);
    const job = Object.values(all).find((v) => v?.job?.url?.endsWith('/big.mp4'));
    const got = (job?.resume?.chunks || []).reduce((n, c) => n + c.received, 0);
    return got > SIZE * 0.3 ? got : null;
  }, 20000);
  const mgrTitle = await evaluate(mgr.sessionId, 'document.title');
  check('progress in the manager tab title', /^\d+% · /.test(mgrTitle), mgrTitle);
  await closeTarget(mgr);
  await sleep(800);
  const afterClose = await evaluate(sw, `chrome.storage.local.get(null)`);
  const savedJob = Object.values(afterClose).find((v) => v?.job?.url?.endsWith('/big.mp4'));
  check('closing the manager: the job stays saved', savedJob?.status === 'running', `saved ${halfway} B, status ${savedJob?.status}`);
  Object.assign(state, { slow: false, slowChunk: 256 * 1024, slowDelay: 15 });
  resetCounters();
  mgr = await openTarget(`chrome-extension://${extId}/manager.html`);
  const cBig = await until('/big.mp4', /done|error/, 30000);
  const bigFile = cBig?.cls.includes('done') && (await waitFor(() => downloaded('big', '.mp4'), 10000));
  const bigSame = bigFile && fs.readFileSync(path.join(chrome.downloads, bigFile)).equals(DATA);
  check('after reopening, the manager finished the download by itself, identical file', bigSame, `${cBig?.status}; ${bigFile}`);
  const bigRefetched = state.served['/big.mp4'] || 0;
  check('…and fetched only the missing part', bigRefetched > 0 && bigRefetched < SIZE * 0.8, `${bigRefetched} of ${SIZE} B`);
  await evaluate(mgr.sessionId, `document.querySelector('#clear-finished').click()`); // failed without data + done
  await sleep(500);
  const leftover = await evaluate(mgr.sessionId, `navigator.storage.getDirectory().then(async (d) => { const n = []; for await (const k of d.keys()) n.push(k); return n; })`);
  check('working files removed (after saving and after removing jobs)', leftover.length === 0, JSON.stringify(leftover));

  // ================= F: HLS TS + subtitles through the popup → one MP4 + .srt =================
  await openTarget(`${base}/p/hls.html`);
  const tabH = await tabOf('/p/hls.html');
  await waitFor(async () => (await storedOf(tabH.id)).some((i) => i.url.endsWith('/m/ts/master.m3u8')), 8000);
  const pH = await openPopup(tabH);
  const subsSelect = await waitFor(() =>
    evaluate(pH.sessionId, `(() => { const s = [...document.querySelectorAll('.opts select')].find(s => s.title.startsWith('Subtitles')); if (!s) return null;
      s.value = '0'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.textContent); })()`)
  , 8000);
  check('popup HLS: choice of subtitles', subsSelect?.includes('Subtitles: Polish (PL)'), JSON.stringify(subsSelect));
  const hlsUi = await evaluate(pH.sessionId, `(() => { const it = document.querySelector('.item'); return { name: it.querySelector('.fname').value,
    quality: [...it.querySelectorAll('.opts select[title^="Quality"] option')].map(o => o.textContent), thumb: it.querySelector('.thumb img')?.getAttribute('src') || null,
    meta: it.querySelector('.meta').textContent }; })()`);
  check(
    'popup: name from the template, estimated size per quality, thumbnail (og:image), duration',
    hlsUi.name === 'HLS video [180p]' && /· ~\d/.test(hlsUi.quality[0]) && hlsUi.thumb?.endsWith('/m/poster.png') && hlsUi.meta.includes('0:08'),
    JSON.stringify(hlsUi)
  );
  await evaluate(pH.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cH = await until('/m/ts/master.m3u8', /done|error/, 30000);
  check('HLS TS → zapisane', cH?.cls.includes('done'), `${cH?.status} | ${cH?.stats}`);
  const hlsMp4 = downloaded('HLS video', '.mp4');
  const hlsPlay = hlsMp4 && (await play(hlsMp4));
  check('HLS TS → one MP4 file, plays with video and audio', playsWell(hlsPlay), `${hlsMp4}: ${JSON.stringify(hlsPlay)}`);
  const srtName = downloaded('HLS video', '.srt');
  const srt = srtName ? fs.readFileSync(path.join(chrome.downloads, srtName), 'utf8') : '';
  check(
    'HLS subtitles → .srt aligned to the start of the video',
    srtName?.endsWith('.pl.srt') && srt.includes('00:00:00,500 --> 00:00:01,900') && srt.includes('Italic <i>text</i> & more') && (srt.match(/-->/g) || []).length === CUES.length,
    srtName
  );
  await closeTarget(pH);

  // ================= G: HLS fMP4 with a choice of audio track =================
  await openTarget(`${base}/p/fmp4.html`);
  const tabF = await tabOf('/p/fmp4.html');
  await waitFor(async () => (await storedOf(tabF.id)).some((i) => i.url.endsWith('/m/f/master.m3u8')), 8000);
  const pF = await openPopup(tabF);
  const audioSel = await waitFor(() =>
    evaluate(pF.sessionId, `(() => { const s = [...document.querySelectorAll('.opts select')].find(s => s.title === 'Audio track'); if (!s) return null;
      s.value = '1'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.textContent); })()`)
  , 8000);
  check('popup HLS: choice of audio track', JSON.stringify(audioSel) === JSON.stringify(['Audio: Polish (PL)', 'Audio: English (EN)']), JSON.stringify(audioSel));
  await evaluate(pF.sessionId, `(() => { const i = document.querySelector('.item .fname'); i.value = 'My name'; i.dispatchEvent(new Event('input')); })()`);
  resetCounters();
  await evaluate(pF.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cF = await until('/m/f/master.m3u8', /done|error/, 30000);
  const enUsed = (state.requests['/m/f/en0.m4s'] || 0) > 0 && !state.requests['/m/f/pl0.m4s'];
  check('fMP4 + chosen EN audio → the English track was downloaded', cF?.cls.includes('done') && enUsed, `${cF?.status}`);
  const fName = downloaded('My name', '.mp4');
  check('popup: changed file name', fName === 'My name.mp4', fName);
  const fPlay = fName && (await play(fName));
  check('HLS fMP4 + separate audio → one MP4, plays', playsWell(fPlay), `${fName}: ${JSON.stringify(fPlay)}`);
  await closeTarget(pF);

  // ================= H: DASH through the manager =================
  await add(`${base}/m/d/manifest.mpd`);
  const cD = await until('/m/d/manifest.mpd', /done|error/, 30000);
  const dName = downloaded('manifest', '.mp4');
  const dPlay = dName && (await play(dName));
  check('DASH → one MP4, plays', cD?.cls.includes('done') && playsWell(dPlay), `${cD?.status}: ${JSON.stringify(dPlay)}`);

  await openTarget(`${base}/p/dash.html`);
  const tabD = await tabOf('/p/dash.html');
  await waitFor(async () => (await storedOf(tabD.id)).some((i) => i.kind === 'dash'), 8000);
  await evaluate(mgr.sessionId, `(() => { const t = document.querySelector('#template'); t.value = '{site} - {title}'; t.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const pTpl = await openPopup(tabD);
  const tplName = await waitFor(() => evaluate(pTpl.sessionId, `document.querySelector('.item .fname')?.value || null`), 8000);
  check('name template from the manager settings', tplName === '127.0.0.1 - DASH video', tplName);
  await closeTarget(pTpl);
  await evaluate(mgr.sessionId, `(() => { const t = document.querySelector('#template'); t.value = ''; t.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const pD = await openPopup(tabD);
  const dashUi = await waitFor(() =>
    evaluate(pD.sessionId, `(() => { const it = [...document.querySelectorAll('.item')].find(e => e.querySelector('.badge.dash')); if (!it || it.textContent.includes('analyzing')) return null;
      const q = it.querySelector('.opts select[title^="Quality"]'); const s = [...it.querySelectorAll('.opts select')].find(s => s.title.startsWith('Subtitles'));
      if (s) { s.value = '0'; s.dispatchEvent(new Event('change')); }
      return { quality: q && [...q.options].map(o => o.textContent), subs: s && [...s.options].map(o => o.textContent), meta: it.querySelector('.meta').textContent }; })()`)
  , 8000);
  check('popup DASH: choice of quality and subtitles', dashUi?.quality?.[0]?.startsWith('180p · 0.20 Mb/s · ~') && dashUi?.subs?.includes('Subtitles: PL'), JSON.stringify(dashUi));
  await evaluate(pD.sessionId, `[...document.querySelectorAll('.item')].find(e => e.querySelector('.badge.dash')).querySelector('.actions button.primary').click()`);
  await until('manifest · 180p', /done|error/, 30000); // the popup job's label (the manager job has the same URL)
  const d2 = downloaded('DASH video', '.mp4');
  const d2Srt = downloaded('DASH video', '.srt');
  check('DASH from the popup → MP4 + .srt subtitles', !!d2 && d2Srt === 'DASH video [180p].pl.srt', `${d2} ${d2Srt}`);
  await closeTarget(pD);

  // ================= I: subtitles from <track> =================
  await openTarget(`${base}/p/track.html`);
  const tabT = await tabOf('/p/track.html');
  await waitFor(async () => (await storedOf(tabT.id)).some((i) => i.subs?.length), 8000);
  await waitFor(async () => Object.values((await evaluate(sw, `chrome.storage.session.get('info:${tabT.id}')`))['info:' + tabT.id]?.videos || {}).some((v) => v.duration), 8000);
  const pT = await openPopup(tabT);
  const trackUi = await waitFor(() => evaluate(pT.sessionId, `(() => { const it = document.querySelector('.item'); return it && { thumb: it.querySelector('.thumb img')?.getAttribute('src') || null, meta: it.querySelector('.meta').textContent }; })()`), 8000);
  check('popup: poster and duration of the <video>', trackUi?.thumb?.endsWith('/m/poster.png') && trackUi.meta.includes('0:08'), JSON.stringify(trackUi));
  const trackSel = await waitFor(() =>
    evaluate(pT.sessionId, `(() => { const s = document.querySelector('.opts select'); if (!s) return null;
      s.value = '0'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.textContent); })()`)
  , 8000);
  check('popup: subtitles from <track> to choose', trackSel?.includes('Subtitles: Polish'), JSON.stringify(trackSel));
  await evaluate(pT.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cT = await until('/m/clip.mp4', /done|error/, 30000);
  const tSrt = downloaded('Video with subtitles', '.srt');
  check('<track> → video + .srt subtitles', cT?.cls.includes('done') && tSrt === 'Video with subtitles [180p].pl.srt' && !!downloaded('Video with subtitles', '.mp4'), `${cT?.status} ${tSrt}`);
  await closeTarget(pT);

  // ================= J: recording a live stream =================
  liveReset({ step: 700 });
  await openTarget(`${base}/p/live.html`);
  const tabL = await tabOf('/p/live.html');
  await waitFor(async () => (await storedOf(tabL.id)).some((i) => i.url.endsWith('/live/index.m3u8')), 8000);
  const pL = await openPopup(tabL);
  const recBtn = await waitFor(() => evaluate(pL.sessionId, `document.querySelector('.item .actions button.primary')?.textContent === '⏺ Record' && document.querySelector('.badge.live') ? 'ok' : null`), 8000);
  check('popup: live stream → "⏺ Record" button', recBtn === 'ok');
  await evaluate(pL.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cRec = await until('/live/index.m3u8', /recording/, 10000);
  check('manager: recording in progress', cRec?.cls.includes('recording') && cRec.buttons.includes('⏹ Stop and save'), `${cRec?.status} [${cRec?.buttons}]`);
  await sleep(4500);
  await clickIn('/live/index.m3u8', '⏹ Stop and save');
  const cLive = await until('/live/index.m3u8', /done|error/, 30000);
  const lName = downloaded('Live stream', '.mp4');
  const lPlay = lName && (await play(lName));
  check('recording → MP4 with video and audio, continuous', cLive?.cls.includes('done') && playsWell(lPlay, 5.5), `${cLive?.stats} | ${JSON.stringify(lPlay)}`);
  await closeTarget(pL);

  // ================= K: recording interrupted by closing the manager → "Save recording" =================
  liveReset({ step: 700 });
  const pL2 = await openPopup(tabL);
  await waitFor(() => evaluate(pL2.sessionId, `document.querySelector('.item .actions button.primary')?.textContent === '⏺ Record' || null`), 8000);
  await evaluate(pL2.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  await closeTarget(pL2);
  await until('/live/index.m3u8', /recording/, 10000);
  await sleep(3500);
  await closeTarget(mgr);
  await sleep(800);
  mgr = await openTarget(`chrome-extension://${extId}/manager.html`);
  const cInt = await until('/live/index.m3u8', /interrupted/, 10000);
  check(
    'after reopening: recording interrupted with "Save recording" / "Keep recording"',
    cInt?.cls.includes('interrupted') && cInt.buttons.includes('Save recording') && cInt.buttons.includes('Keep recording'),
    `${cInt?.status} [${cInt?.buttons}]`
  );
  const before = fs.readdirSync(chrome.downloads).filter((f) => f.startsWith('Live stream')).length;
  await clickIn('/live/index.m3u8', 'Save recording');
  const cSaved = await until('/live/index.m3u8', /done|error/, 30000);
  const savedName = await waitFor(() => fs.readdirSync(chrome.downloads).filter((f) => f.startsWith('Live stream') && f.endsWith('.mp4')).length > before && fs.readdirSync(chrome.downloads).filter((f) => f.startsWith('Live stream') && f.endsWith('.mp4')).sort().pop(), 10000);
  const savedPlay = savedName && (await play(savedName));
  check('"Save recording" → MP4 with the recorded part', cSaved?.cls.includes('done') && playsWell(savedPlay, 3), `${savedName}: ${JSON.stringify(savedPlay)}`);

  // ================= L: context menu, notification, history =================
  await send('Page.bringToFront', {}, page.sessionId); // manager in the background → notification
  const ctxJob = await evaluate(sw, `tvdDownloadFromContext({ menuItemId: 'tvd-link', linkUrl: '${base}/m/ctx.mp4', pageUrl: '${base}/p/hls.html' }, ${JSON.stringify(tabH)})`);
  check('context menu: link → a job named from the template', ctxJob?.filename === 'HLS video', ctxJob?.filename);
  const cCtx = await until('/m/ctx.mp4', /done|error/, 30000);
  const hidden = await evaluate(mgr.sessionId, 'document.hidden');
  check('… downloaded to "HLS video.mp4"', cCtx?.cls.includes('done') && fs.existsSync(path.join(chrome.downloads, 'HLS video.mp4')), cCtx?.status);
  const note = await waitFor(async () => Object.keys(await evaluate(sw, 'chrome.notifications.getAll()')).find((k) => k.startsWith('tvd-done:')) || null, 5000);
  check('notification when done while the manager is in the background', !!note, `${note} (manager hidden: ${hidden})`);
  const blobRes = await evaluate(sw, `tvdDownloadFromContext({ menuItemId: 'tvd-video', srcUrl: 'blob:${base}/x', pageUrl: '${base}/p/hls.html' }, ${JSON.stringify(tabH)})`);
  check('context menu: a video played from a stream (blob:) creates no job', blobRes === null);

  await send('Page.bringToFront', {}, mgr.sessionId);
  await evaluate(mgr.sessionId, 'location.reload(), 1');
  const hist = await waitFor(async () => {
    const h = await evaluate(mgr.sessionId, `(() => { const rows = [...document.querySelectorAll('#history .entry')];
      return rows.length ? rows.map(r => ({ name: r.querySelector('.name').textContent, show: !r.querySelector('button').disabled })) : null; })()`);
    return h && h.some((x) => x.show) ? h : null;
  }, 10000);
  check(
    'history survived reloading the manager, "Show" works',
    hist?.length >= 10 && hist.some((h) => h.name.startsWith('flaky.mp4') && h.show) && hist[0].name.startsWith('HLS video.mp4'),
    `${hist?.length} entries; ${hist?.slice(0, 3).map((h) => h.name).join(' | ')}`
  );
  await evaluate(mgr.sessionId, `[...document.querySelectorAll('#history .entry')].find(r => r.querySelector('.name').textContent.startsWith('flaky.mp4')).querySelectorAll('button')[1].click()`);
  const again = await waitFor(() => downloaded('flaky (1)', '.mp4'), 30000);
  check('history: "Download again"', !!again, again);

  // ================= N: YouTube through the helper program (personal build) =================
  // The extension talks to native/host.mjs; a test copy of the helper is registered under its own name
  // (HKCU registry, removed at the end) and runs the fake yt-dlp from tests/fake-ytdlp.mjs.
  const personal = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'manifest.json'), 'utf8')).permissions.includes('nativeMessaging');
  const ytTab = { id: 987654, windowId: 1, active: true, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: '(2) Big Buck Bunny - YouTube' };
  const ytCard = (p) =>
    evaluate(
      p.sessionId,
      `(() => { const c = document.querySelector('#list > .item.external'); return c && { name: c.querySelector('.fname').value, meta: c.querySelector('.meta').textContent,
        note: c.querySelector('.note').hidden ? '' : c.querySelector('.note').textContent, button: !c.querySelector('.actions button').disabled,
        options: [...c.querySelectorAll('.opts select:first-child option')].map(o => (o.disabled ? '-' : '') + o.textContent), quality: c.querySelector('.opts select')?.value }; })()`
    );
  const setHost = (name) =>
    evaluate(sw, `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, nativeHost: ${JSON.stringify(name)} } }))`);
  if (!personal) {
    const p = await openPopup(ytTab);
    await sleep(1500);
    check('store package: no YouTube card in the popup', (await ytCard(p)) === null);
    check('store package: no YouTube panel in the manager', !(await evaluate(mgr.sessionId, `!!document.querySelector('#youtube')`)));
    await closeTarget(p);
  } else if (process.platform !== 'win32') {
    console.log('SKIP  YouTube: registering the test helper is implemented for Windows only');
  } else {
    // Helper missing: the popup says so and the manager panel shows how to install it.
    await setHost('com.turbovd.ytdlp.missing');
    await evaluate(mgr.sessionId, 'location.reload(), 1');
    const panel = await waitFor(async () => {
      const s = await evaluate(mgr.sessionId, `(() => { const d = document.querySelector('#youtube'); return d && !d.textContent.includes('checking') && { summary: d.querySelector('summary').textContent, open: d.open, code: [...d.querySelectorAll('code')].map(c => c.textContent) }; })()`);
      return s || null;
    }, 10000);
    check(
      'YouTube panel without the helper: open, with the install command',
      panel?.summary === 'YouTube (yt-dlp) – not set up' && panel.open && panel.code.includes(`node native/install.mjs ${extId}`),
      JSON.stringify(panel)
    );
    const pMissing = await openPopup(ytTab);
    const missing = await waitFor(async () => {
      const c = await ytCard(pMissing);
      return c && c.note ? c : null;
    }, 8000);
    check(
      'popup without the helper: YouTube card with a setup hint',
      missing?.note.startsWith("The YouTube helper program isn't installed.") && missing.note.includes('How to set it up') && !missing.button && missing.name === 'Big Buck Bunny',
      JSON.stringify(missing)
    );
    await closeTarget(pMissing);

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvd-e2e-host-'));
    const outDir = path.join(hostDir, 'out');
    const TEST_HOST = 'com.turbovd.ytdlp.test';
    const keys = ['Google\\Chrome', 'Chromium'].map((b) => `HKCU\\Software\\${b}\\NativeMessagingHosts\\${TEST_HOST}`);
    const wrapper = path.join(hostDir, 'host.cmd');
    const vars = {
      TVD_YTDLP: fileURLToPath(new URL('./fake-ytdlp.mjs', import.meta.url)),
      TVD_FFMPEG: 'none',
      TVD_OUTDIR: outDir,
      TVD_CONFIG: path.join(hostDir, 'no-config.json'),
      TVD_LOG: path.join(hostDir, 'host.log'),
      FAKE_YTDLP_DELAY: '120'
    };
    fs.writeFileSync(
      wrapper,
      ['@echo off', ...Object.entries(vars).map(([k, v]) => `set "${k}=${v}"`), `"${process.execPath}" "${path.join(EXT_ROOT, 'native', 'host.mjs')}" %*`, ''].join('\r\n')
    );
    const manifestPath = path.join(hostDir, `${TEST_HOST}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({ name: TEST_HOST, description: 'test', path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] }));
    const regOk = keys.every((k) => spawnSync('reg', ['add', k, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true }).status === 0);
    check('YouTube: test helper registered', regOk);
    try {
      await setHost(TEST_HOST);
      await evaluate(mgr.sessionId, `[...document.querySelectorAll('#youtube button')].find(b => b.textContent === 'Check again').click()`);
      const ready = await waitFor(async () => {
        const s = await evaluate(mgr.sessionId, `document.querySelector('#youtube').textContent`);
        return s.includes('– ready') ? s : null;
      }, 10000);
      check('YouTube panel: ready, yt-dlp version and the output folder', ready?.includes('yt-dlp 2099.01.01 (fake) ✓') && ready.includes(outDir), ready?.slice(0, 200));

      const pY = await openPopup(ytTab);
      const ui = await waitFor(async () => {
        const c = await ytCard(pY);
        return c?.button ? c : null;
      }, 15000);
      check(
        'popup: YouTube card with qualities from yt-dlp (WebM-only needs ffmpeg), 1080p by default',
        ui?.options[0].startsWith('-1440p60 · VP9') && ui.options[0].includes('needs ffmpeg') && ui.options.some((o) => o.startsWith('1080p60 · H.264 · ~')) &&
          ui.options.at(-1).startsWith('Audio only (M4A)') && ui.quality === '299' && ui.name === 'Big Buck Bunny test video [1080p60]' && ui.meta.includes('Test channel'),
        JSON.stringify(ui)
      );
      await evaluate(
        pY.sessionId,
        `(() => { const c = document.querySelector('.item.external'); const s = c.querySelectorAll('.opts select')[1]; s.value = '0'; s.dispatchEvent(new Event('change'));
          c.querySelector('.actions button').click(); })()`
      );
      await sleep(500);
      await closeTarget(pY);
      const running = await until('aqz-KE-bpKQ', /running/, 15000);
      check('manager: the YouTube download runs with progress', /running/.test(running?.cls) && /Downloaded/.test(running.stats), `${running?.status} | ${running?.stats}`);
      const cY = await until('aqz-KE-bpKQ', /done|error/, 30000);
      const outFiles = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
      const mp4 = outFiles.find((f) => f.endsWith('[1080p60].mp4'));
      const yPlay = mp4 && (await play(mp4, outDir));
      check(
        'YouTube → one MP4 + .srt in the helper folder, plays',
        cY?.cls.includes('done') && cY.buttons.includes('Show in folder') && outFiles.some((f) => f.endsWith('[1080p60].en.srt')) && playsWell(yPlay),
        `${cY?.status} [${cY?.buttons}] ${JSON.stringify(outFiles)} ${JSON.stringify(yPlay)}`
      );

      // Pause and resume: the helper keeps yt-dlp's partial file and continues it.
      const pY2 = await openPopup(ytTab);
      await waitFor(async () => (await ytCard(pY2))?.button || null, 10000);
      await evaluate(pY2.sessionId, `(() => { const c = document.querySelector('.item.external'); c.querySelector('.fname').value = 'Paused bunny'; c.querySelector('.actions button').click(); })()`);
      await sleep(500);
      await closeTarget(pY2);
      await waitFor(async () => {
        const c = await card('Big Buck Bunny'); // the newest card comes first
        return c && /running/.test(c.cls) && /Downloaded [1-9]/.test(c.stats) ? c : null;
      }, 15000);
      await evaluate(mgr.sessionId, `[...document.querySelectorAll('.job')].find(c => c.querySelector('.title').textContent.includes('Big Buck Bunny') && c.className.includes('running')).querySelector('.buttons button').click()`);
      const paused = await until('Big Buck Bunny', /paused/, 10000);
      check('YouTube: pause keeps the downloaded part ("Resume")', paused?.buttons.includes('Resume') && /Kept/.test(paused.stats), `${paused?.status} [${paused?.buttons}] ${paused?.stats}`);
      const partial = fs.readdirSync(path.join(outDir, '.turbo-video-downloader')).length;
      await evaluate(mgr.sessionId, `[...document.querySelectorAll('.job.paused .buttons button')].find(b => b.textContent === 'Resume').click()`);
      await sleep(300);
      const resumed = await waitFor(async () => {
        const all = await evaluate(mgr.sessionId, `[...document.querySelectorAll('.job')].map(c => c.className + ' ' + c.querySelector('.status').textContent)`);
        return all.filter((s) => /done/.test(s)).length >= 2 ? all : null;
      }, 30000);
      check(
        'YouTube: resumed and finished, partial files removed',
        !!resumed && partial === 1 && fs.existsSync(path.join(outDir, 'Paused bunny.mp4')) && !fs.existsSync(path.join(outDir, '.turbo-video-downloader')),
        JSON.stringify(resumed)
      );
      const ytHist = await evaluate(
        mgr.sessionId,
        `[...document.querySelectorAll('#history .entry')].slice(0, 2).map(r => ({ name: r.querySelector('.name').textContent, show: !r.querySelector('button').disabled }))`
      );
      check('YouTube downloads in the history, "Show" available', ytHist[0]?.name.startsWith('Paused bunny.mp4') && ytHist.every((h) => h.show), JSON.stringify(ytHist));
    } finally {
      for (const k of keys) spawnSync('reg', ['delete', k, '/f'], { windowsHide: true });
      await setHost('');
      fs.rmSync(hostDir, { recursive: true, force: true });
    }
  }

  // ================= M: Polish user interface (chrome.i18n, a second browser with lang=pl) =================
  const plChrome = await launchChrome({ lang: 'pl' });
  try {
    const { id: plId } = await plChrome.send('Extensions.loadUnpacked', { path: EXT_ROOT });
    const pm = await plChrome.openTarget(`chrome-extension://${plId}/manager.html`);
    await waitFor(() => plChrome.evaluate(pm.sessionId, `document.readyState === 'complete' && !!document.querySelector('#jobs .empty')`), 8000);
    const ui = await plChrome.evaluate(
      pm.sessionId,
      `({ lang: chrome.i18n.getUILanguage(), h1: document.querySelector('h1').textContent, title: document.title,
         label: document.querySelector('#settings label span').textContent, placeholder: document.querySelector('#add-url').placeholder,
         empty: document.querySelector('#jobs .empty').textContent, preview: document.querySelector('#template-preview').textContent })`
    );
    check(
      'Polish UI: manager texts from _locales/pl',
      ui.lang.startsWith('pl') && ui.h1 === 'Menedżer pobierania' && ui.title.startsWith('Menedżer pobierania') && ui.label === 'Połączenia na plik' &&
        ui.placeholder.startsWith('Wklej link') && ui.empty.startsWith('Brak pobrań') && ui.preview === 'np. „Film o kotach [720p]”',
      JSON.stringify(ui)
    );
    const plAdd = (url) =>
      plChrome.evaluate(pm.sessionId, `(() => { document.querySelector('#add-url').value = ${JSON.stringify(url)}; document.querySelector('#add-form').requestSubmit(); })()`);
    await plAdd(`${base}/forbid.mp4`);
    const plErr = await waitFor(
      () => plChrome.evaluate(pm.sessionId, `document.querySelector('.job.error .status')?.textContent || null`),
      15000
    );
    check('Polish UI: engine error with a substitution ($1 → 403)', /^błąd: Brak dostępu \(HTTP 403\) – link mógł wygasnąć/.test(plErr || ''), plErr);
    const plButtons = await plChrome.evaluate(pm.sessionId, `[...document.querySelectorAll('.job .buttons button')].map(b => b.textContent)`);
    check('Polish UI: job buttons', plButtons.includes('Ponów'), JSON.stringify(plButtons));
  } finally {
    await plChrome.close();
  }
} catch (e) {
  check('test run', false, e.stack);
  console.log(chrome.stderr().slice(-3000));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  await chrome.close();
  server.close();
  process.exit(failed ? 1 : 0);
}
