// Test rozszerzenia w prawdziwym Chrome: ładuje rozszerzenie do tymczasowego profilu
// (CDP przez pipe + Extensions.loadUnpacked, Chrome 126+) i sprawdza na lokalnych stronach:
// wykrywanie i licznik, SPA, popup, content.js, menedżer (błędy, wznawianie także po zamknięciu),
// łączenie w MP4 (odtwarzane w Chrome), napisy .srt, DASH, wybór audio i nagrywanie na żywo.
//
// Uruchom: npm run test:e2e
//   CHROME=ścieżka   – inny Chrome/Chromium (domyślnie szukany w typowych miejscach)
//   HEADFUL=1        – pokaż okno przeglądarki
//   KEEP=1           – nie usuwaj profilu i pobranych plików (ścieżka jest wypisywana)
import fs from 'node:fs';
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

// ---------------------------------------------------------------- materiały
const M3U8 = 'application/vnd.apple.mpegurl';
function mediaAssets() {
  // HLS TS (obraz + dźwięk) z napisami WebVTT
  const cc = { v: { cc: 0 }, a: { cc: 0 }, psi: 0 };
  for (let i = 0; i < 4; i++) assets[`/m/ts/seg${i}.ts`] = { type: 'video/mp2t', body: buildTs(fx, i * 2, i * 2 + 2, { cc }) };
  assets['/m/ts/v.m3u8'] = { type: M3U8, body: mediaPlaylist([0, 1, 2, 3].map((i) => ({ uri: `seg${i}.ts`, dur: 2 }))) };
  vttSegments().forEach((v, i) => (assets[`/m/ts/sub${i}.vtt`] = { type: 'text/vtt', body: v }));
  assets['/m/ts/subs.m3u8'] = { type: M3U8, body: mediaPlaylist([0, 1, 2, 3].map((i) => ({ uri: `sub${i}.vtt`, dur: 2 }))) };
  assets['/m/ts/master.m3u8'] = {
    type: M3U8,
    body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Polskie",LANGUAGE="pl",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,SUBTITLES="s"\nv.m3u8\n'
  };

  // HLS fMP4 z dwiema ścieżkami audio (pl / en)
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
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Polski",LANGUAGE="pl",DEFAULT=YES,URI="pl.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="en.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,AUDIO="a"\nv.m3u8\n'
  };

  // DASH: SegmentTemplate + SegmentTimeline, napisy WebVTT
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

  // Transmisja na żywo: kolejne segmenty TS z ciągłą osią czasu.
  const liveCache = new Map();
  const liveCc = { v: { cc: 0 }, a: { cc: 0 }, psi: 0 };
  liveState.segments = (n) => {
    if (!liveCache.has(n)) liveCache.set(n, buildTs(fx, (n % 4) * 2, (n % 4) * 2 + 2, { shift: n * 2 - (n % 4) * 2, cc: liveCc }));
    return liveCache.get(n);
  };
  assets['/big.mp4'] = { type: 'video/mp4', body: DATA };
}

const fetcher = (urls) => `<script>(async () => { for (const u of ${JSON.stringify(urls)}) await (await fetch(u)).text(); })();</script>`;
pages['/p/hls.html'] = `<!doctype html><title>Wideo HLS</title>${fetcher(['/m/ts/master.m3u8', '/m/ts/v.m3u8'])}`;
pages['/p/fmp4.html'] = `<!doctype html><title>Wideo fMP4</title>${fetcher(['/m/f/master.m3u8', '/m/f/v.m3u8', '/m/f/pl.m3u8'])}`;
pages['/p/dash.html'] = `<!doctype html><title>Wideo DASH</title>${fetcher(['/m/d/manifest.mpd'])}`;
pages['/p/live.html'] = `<!doctype html><title>Transmisja</title>${fetcher(['/live/index.m3u8'])}`;
pages['/p/track.html'] = `<!doctype html><title>Film z napisami</title>
  <video src="/ok.mp4" preload="metadata" muted><track src="/m/d/pl.vtt" kind="subtitles" srclang="pl" label="Polski"></video>`;
pages['/player.html'] = `<!doctype html><title>player</title><body><script>
window.check = async (src) => {
  const v = document.createElement('video'); v.muted = true; v.src = src; document.body.append(v);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('błąd wczytania: ' + (v.error && v.error.message))); setTimeout(() => rej(new Error('nie wczytał się w 10 s')), 10000); });
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

/** Odtwarza plik z folderu pobrań w Chrome i zwraca statystyki odtwarzania. */
let player = null;
async function play(name) {
  const route = '/dl/' + encodeURIComponent(name);
  assets[route] = { type: 'video/mp4', body: () => fs.readFileSync(path.join(chrome.downloads, name)) };
  if (!player) {
    player = await openTarget(`${base}/player.html`);
    await waitFor(() => evaluate(player.sessionId, `typeof window.check === 'function'`));
  }
  // Chrome wstrzymuje wyciszone wideo w kartach w tle – odtwarzacz musi być na wierzchu.
  await send('Page.bringToFront', {}, player.sessionId);
  return evaluate(player.sessionId, `check(${JSON.stringify(route)})`).catch((e) => ({ error: e.message }));
}
const playsWell = (r, minDur = 7.5) =>
  r && !r.error && r.ended && r.width === 320 && r.height === 180 && r.duration > minDur && r.frames > 0 && r.audioBytes > 0;

try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT_ROOT });
  console.log('rozszerzenie:', extId);

  const swTarget = await waitFor(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
  });
  const { sessionId: sw } = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  await evaluate(sw, '1');

  const tabOf = (part) => waitFor(() => evaluate(sw, `chrome.tabs.query({}).then(ts => ts.find(t => t.url?.includes(${JSON.stringify(part)})))`));
  const badgeOf = (tabId) => evaluate(sw, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  const storedOf = (tabId) => evaluate(sw, `chrome.storage.session.get('tab:${tabId}').then(o => Object.values(o['tab:${tabId}'] || {}))`);

  /** Popup dla karty (popup bierze aktywną kartę – podmieniamy ją na testową). */
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

  // ================= A: wykrywanie + licznik bez wariantów HLS =================
  pages['/video.html'] = `<!doctype html><html><head><meta charset="utf-8"><title>Film testowy A</title></head><body>
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
  check('wykryto plik i 3 playlisty HLS', itemsA.length === 4, `${itemsA.length} pozycji; ${hlsInfo.join(', ')}`);
  const bA = await waitFor(async () => ((await badgeOf(tabId)) === '2' ? '2' : null), 5000);
  check('licznik = 2 (MP4 + master), warianty HLS nie liczone', bA === '2', `licznik: "${await badgeOf(tabId)}"`);

  // ================= C: content.js – tylko nowe elementy =================
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
  check('content.js: nowy link, zmieniony href i <source> w nowym węźle', !!domOk);
  await evaluate(
    page.sessionId,
    `(() => {
      const feed = document.getElementById('feed');
      for (let i = 0; i < 2500; i++) { const p = document.createElement('p'); p.textContent = i; feed.append(p); }
      const a = document.createElement('a'); a.href = '/clip-mass.mp4'; feed.append(a);
    })()`
  );
  const massOk = await waitFor(async () => (await storedOf(tabId)).some((i) => i.url === base + '/clip-mass.mp4'), 5000);
  check('content.js: masowa zmiana (>2000 węzłów) → pełny skan nadal wykrywa', !!massOk);
  const bC = await waitFor(async () => ((await badgeOf(tabId)) === '6' ? '6' : null), 5000);
  check('licznik = 6 po dodaniu 4 filmów ze strony', bC === '6', `licznik: "${await badgeOf(tabId)}"`);

  // ================= B: SPA =================
  await evaluate(page.sessionId, `history.pushState({}, '', '/video2.html'); document.title = 'Film B'; 1`);
  const bB = await waitFor(async () => ((await badgeOf(tabId)) === '' ? 'empty' : null), 5000);
  check('SPA: po zmianie podstrony licznik = 0', bB === 'empty', `licznik: "${await badgeOf(tabId)}"`);
  await evaluate(
    page.sessionId,
    `(() => { const v = document.createElement('video'); v.src = '/ok.mp4?v=2'; v.preload = 'auto'; v.muted = true; document.body.append(v); })()`
  );
  const bB2 = await waitFor(async () => ((await badgeOf(tabId)) === '1' ? '1' : null), 6000);
  check('SPA: nowy film na nowej podstronie → licznik = 1', bB2 === '1', `licznik: "${await badgeOf(tabId)}"`);

  const popupA = await openPopup(await evaluate(sw, `chrome.tabs.get(${tabId})`));
  const popupState = await waitFor(async () => {
    const s = await evaluate(
      popupA.sessionId,
      `({
        current: [...document.querySelectorAll('#list > .item .name')].map(e => e.textContent),
        earlierSummary: document.querySelector('#list > details.earlier > summary')?.textContent || null,
        earlierOpen: document.querySelector('#list > details.earlier')?.open,
        earlier: [...document.querySelectorAll('#list > details.earlier .item .name')].map(e => e.textContent),
        hlsMeta: [...document.querySelectorAll('.item')].filter(e => e.querySelector('.badge.hls')).map(e => e.querySelector('.meta').textContent)
      })`
    );
    return s.earlier.length && s.hlsMeta.every((m) => !m.includes('analizuję')) ? s : null;
  }, 8000);
  check('popup: bieżąca podstrona = 1 film', popupState?.current.length === 1, JSON.stringify(popupState?.current));
  check(
    'popup: sekcja „Wcześniej na tej karcie (6)”, zwinięta',
    popupState?.earlierSummary === 'Wcześniej na tej karcie (6)' && popupState?.earlierOpen === false,
    `${popupState?.earlierSummary}, open=${popupState?.earlierOpen}`
  );
  check(
    'popup: warianty HLS ukryte (jest tylko master z wyborem jakości)',
    popupState?.hlsMeta.length === 1 && popupState.hlsMeta[0].includes('2 jakości'),
    JSON.stringify(popupState?.hlsMeta)
  );
  await evaluate(
    popupA.sessionId,
    `(() => { const d = document.querySelector('details.earlier'); d.open = true;
      const item = [...d.querySelectorAll('.item')].find(e => e.querySelector('.name').title.endsWith('/ok.mp4'));
      item.querySelector('.actions button:not(.primary)').click(); })()`
  );
  const named = await waitFor(() => downloaded('Film testowy A'), 10000);
  check('popup: wcześniejszy film nazwany tytułem swojej podstrony', !!named, `plik: ${named}`);
  await closeTarget(popupA);

  // ================= D: menedżer – błędy i wznawianie =================
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
  check('menedżer: strona HTML zamiast filmu → czytelny błąd', /stronę WWW/.test(cExp?.status || ''), `${Date.now() - t} ms: ${cExp?.status}`);

  t = Date.now();
  await add(`${base}/forbid.mp4`);
  const cFor = await until('/forbid.mp4', /error/, 15000);
  check('menedżer: 403 → szybki błąd z podpowiedzią', /Brak dostępu \(HTTP 403\)/.test(cFor?.status || '') && Date.now() - t < 5000, `${Date.now() - t} ms`);

  state.flakyBudget = 7 * 1024 * 1024;
  resetCounters();
  await add(`${base}/flaky.mp4`);
  const cFl = await until('/flaky.mp4', /error/, 15000);
  check(
    'menedżer: po błędzie „Wznów” i informacja o zachowanych danych',
    cFl?.buttons.includes('Wznów') && /Zachowano/.test(cFl?.stats || ''),
    `${cFl?.stats} | [${cFl?.buttons}]`
  );
  await sleep(300);
  state.flakyBudget = Infinity;
  resetCounters();
  await clickIn('/flaky.mp4', 'Wznów');
  const cDone = await until('/flaky.mp4', /done/, 30000);
  const flakyFile = cDone && (await waitFor(() => downloaded('flaky', '.mp4'), 10000));
  check('menedżer: „Wznów” kończy pobieranie, plik identyczny', flakyFile && fs.readFileSync(path.join(chrome.downloads, flakyFile)).equals(DATA), flakyFile);
  const refetched = (state.served['/flaky.mp4'] || 0) - 1;
  check('menedżer: wznowienie nie pobiera od zera', refetched > 0 && refetched < SIZE, `drugi raz pobrano ${refetched} z ${SIZE} B`);

  // ================= E: zamknięcie menedżera w trakcie i wznowienie =================
  Object.assign(state, { slow: true, slowChunk: 32 * 1024, slowDelay: 25 });
  resetCounters();
  await add(`${base}/big.mp4`);
  const halfway = await waitFor(async () => {
    const all = await evaluate(sw, `chrome.storage.local.get(null)`);
    const job = Object.values(all).find((v) => v?.job?.url?.endsWith('/big.mp4'));
    const got = (job?.resume?.chunks || []).reduce((n, c) => n + c.received, 0);
    return got > SIZE * 0.3 ? got : null;
  }, 20000);
  await closeTarget(mgr);
  await sleep(800);
  const afterClose = await evaluate(sw, `chrome.storage.local.get(null)`);
  const savedJob = Object.values(afterClose).find((v) => v?.job?.url?.endsWith('/big.mp4'));
  check('zamknięcie menedżera: zadanie zostaje zapisane', savedJob?.status === 'running', `zapisane ${halfway} B, status ${savedJob?.status}`);
  Object.assign(state, { slow: false, slowChunk: 256 * 1024, slowDelay: 15 });
  resetCounters();
  mgr = await openTarget(`chrome-extension://${extId}/manager.html`);
  const cBig = await until('/big.mp4', /done|error/, 30000);
  const bigFile = cBig?.cls.includes('done') && (await waitFor(() => downloaded('big', '.mp4'), 10000));
  const bigSame = bigFile && fs.readFileSync(path.join(chrome.downloads, bigFile)).equals(DATA);
  check('po ponownym otwarciu menedżer sam dokończył pobieranie, plik identyczny', bigSame, `${cBig?.status}; ${bigFile}`);
  const bigRefetched = state.served['/big.mp4'] || 0;
  check('…i dociągnął tylko brakującą część', bigRefetched > 0 && bigRefetched < SIZE * 0.8, `${bigRefetched} z ${SIZE} B`);
  await evaluate(mgr.sessionId, `document.querySelector('#clear-finished').click()`); // błędne bez danych + gotowe
  await sleep(500);
  const leftover = await evaluate(mgr.sessionId, `navigator.storage.getDirectory().then(async (d) => { const n = []; for await (const k of d.keys()) n.push(k); return n; })`);
  check('pliki robocze usunięte (po zapisie i po usunięciu zadań)', leftover.length === 0, JSON.stringify(leftover));

  // ================= F: HLS TS + napisy przez popup → jeden MP4 + .srt =================
  await openTarget(`${base}/p/hls.html`);
  const tabH = await tabOf('/p/hls.html');
  await waitFor(async () => (await storedOf(tabH.id)).some((i) => i.url.endsWith('/m/ts/master.m3u8')), 8000);
  const pH = await openPopup(tabH);
  const subsSelect = await waitFor(() =>
    evaluate(pH.sessionId, `(() => { const s = [...document.querySelectorAll('.opts select')].find(s => s.title.startsWith('Napisy')); if (!s) return null;
      s.value = '0'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.textContent); })()`)
  , 8000);
  check('popup HLS: wybór napisów', subsSelect?.includes('Napisy: Polskie (PL)'), JSON.stringify(subsSelect));
  await evaluate(pH.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cH = await until('/m/ts/master.m3u8', /done|error/, 30000);
  check('HLS TS → zapisane', cH?.cls.includes('done'), `${cH?.status} | ${cH?.stats}`);
  const hlsMp4 = downloaded('Wideo HLS', '.mp4');
  const hlsPlay = hlsMp4 && (await play(hlsMp4));
  check('HLS TS → jeden plik MP4, odtwarza się z obrazem i dźwiękiem', playsWell(hlsPlay), `${hlsMp4}: ${JSON.stringify(hlsPlay)}`);
  const srtName = downloaded('Wideo HLS', '.srt');
  const srt = srtName ? fs.readFileSync(path.join(chrome.downloads, srtName), 'utf8') : '';
  check(
    'napisy HLS → .srt wyrównany do początku filmu',
    srtName?.endsWith('.pl.srt') && srt.includes('00:00:00,500 --> 00:00:01,900') && srt.includes('Napis <i>pochyły</i> & drugi') && (srt.match(/-->/g) || []).length === CUES.length,
    srtName
  );
  await closeTarget(pH);

  // ================= G: HLS fMP4 z wyborem ścieżki audio =================
  await openTarget(`${base}/p/fmp4.html`);
  const tabF = await tabOf('/p/fmp4.html');
  await waitFor(async () => (await storedOf(tabF.id)).some((i) => i.url.endsWith('/m/f/master.m3u8')), 8000);
  const pF = await openPopup(tabF);
  const audioSel = await waitFor(() =>
    evaluate(pF.sessionId, `(() => { const s = [...document.querySelectorAll('.opts select')].find(s => s.title === 'Ścieżka dźwiękowa'); if (!s) return null;
      s.value = '1'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.textContent); })()`)
  , 8000);
  check('popup HLS: wybór ścieżki audio', JSON.stringify(audioSel) === JSON.stringify(['Audio: Polski (PL)', 'Audio: English (EN)']), JSON.stringify(audioSel));
  resetCounters();
  await evaluate(pF.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cF = await until('/m/f/master.m3u8', /done|error/, 30000);
  const enUsed = (state.requests['/m/f/en0.m4s'] || 0) > 0 && !state.requests['/m/f/pl0.m4s'];
  check('fMP4 + wybrane audio EN → pobrana ścieżka angielska', cF?.cls.includes('done') && enUsed, `${cF?.status}`);
  const fName = downloaded('Wideo fMP4', '.mp4');
  const fPlay = fName && (await play(fName));
  check('HLS fMP4 + osobne audio → jeden MP4, odtwarza się', playsWell(fPlay), `${fName}: ${JSON.stringify(fPlay)}`);
  await closeTarget(pF);

  // ================= H: DASH przez menedżer =================
  await add(`${base}/m/d/manifest.mpd`);
  const cD = await until('/m/d/manifest.mpd', /done|error/, 30000);
  const dName = downloaded('manifest', '.mp4');
  const dPlay = dName && (await play(dName));
  check('DASH → jeden MP4, odtwarza się', cD?.cls.includes('done') && playsWell(dPlay), `${cD?.status}: ${JSON.stringify(dPlay)}`);

  await openTarget(`${base}/p/dash.html`);
  const tabD = await tabOf('/p/dash.html');
  await waitFor(async () => (await storedOf(tabD.id)).some((i) => i.kind === 'dash'), 8000);
  const pD = await openPopup(tabD);
  const dashUi = await waitFor(() =>
    evaluate(pD.sessionId, `(() => { const it = [...document.querySelectorAll('.item')].find(e => e.querySelector('.badge.dash')); if (!it || it.textContent.includes('analizuję')) return null;
      const q = it.querySelector('.actions select'); const s = [...it.querySelectorAll('.opts select')].find(s => s.title.startsWith('Napisy'));
      if (s) { s.value = '0'; s.dispatchEvent(new Event('change')); }
      return { quality: q && [...q.options].map(o => o.textContent), subs: s && [...s.options].map(o => o.textContent), meta: it.querySelector('.meta').textContent }; })()`)
  , 8000);
  check('popup DASH: jakość i napisy do wyboru', dashUi?.quality?.[0] === '180p · 0.20 Mb/s' && dashUi?.subs?.includes('Napisy: PL'), JSON.stringify(dashUi));
  await evaluate(pD.sessionId, `[...document.querySelectorAll('.item')].find(e => e.querySelector('.badge.dash')).querySelector('.actions button.primary').click()`);
  const cD2 = await until('Wideo DASH', /done|error/, 30000) || (await until('manifest.mpd · 180p', /done|error/, 1));
  const d2 = downloaded('Wideo DASH', '.mp4');
  const d2Srt = downloaded('Wideo DASH', '.srt');
  check('DASH z popupu → MP4 + napisy .srt', !!d2 && d2Srt === 'Wideo DASH [180p].pl.srt', `${d2} ${d2Srt}`);
  await closeTarget(pD);

  // ================= I: napisy z <track> =================
  await openTarget(`${base}/p/track.html`);
  const tabT = await tabOf('/p/track.html');
  await waitFor(async () => (await storedOf(tabT.id)).some((i) => i.subs?.length), 8000);
  const pT = await openPopup(tabT);
  const trackSel = await waitFor(() =>
    evaluate(pT.sessionId, `(() => { const s = document.querySelector('.opts select'); if (!s) return null;
      s.value = '0'; s.dispatchEvent(new Event('change')); return [...s.options].map(o => o.textContent); })()`)
  , 8000);
  check('popup: napisy z <track> do wyboru', trackSel?.includes('Napisy: Polski'), JSON.stringify(trackSel));
  await evaluate(pT.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cT = await until('/ok.mp4', /done|error/, 30000);
  const tSrt = downloaded('Film z napisami', '.srt');
  check('<track> → film + napisy .srt', cT?.cls.includes('done') && tSrt === 'Film z napisami.pl.srt' && !!downloaded('Film z napisami', '.mp4'), `${cT?.status} ${tSrt}`);
  await closeTarget(pT);

  // ================= J: nagrywanie transmisji na żywo =================
  liveReset({ step: 700 });
  await openTarget(`${base}/p/live.html`);
  const tabL = await tabOf('/p/live.html');
  await waitFor(async () => (await storedOf(tabL.id)).some((i) => i.url.endsWith('/live/index.m3u8')), 8000);
  const pL = await openPopup(tabL);
  const recBtn = await waitFor(() => evaluate(pL.sessionId, `document.querySelector('.item .actions button.primary')?.textContent === '⏺ Nagrywaj' && document.querySelector('.badge.live') ? 'ok' : null`), 8000);
  check('popup: transmisja → przycisk „⏺ Nagrywaj”', recBtn === 'ok');
  await evaluate(pL.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  const cRec = await until('/live/index.m3u8', /recording/, 10000);
  check('menedżer: trwa nagrywanie', cRec?.cls.includes('recording') && cRec.buttons.includes('⏹ Zatrzymaj i zapisz'), `${cRec?.status} [${cRec?.buttons}]`);
  await sleep(4500);
  await clickIn('/live/index.m3u8', '⏹ Zatrzymaj i zapisz');
  const cLive = await until('/live/index.m3u8', /done|error/, 30000);
  const lName = downloaded('Transmisja', '.mp4');
  const lPlay = lName && (await play(lName));
  check('nagranie → MP4 z obrazem i dźwiękiem, ciągłe', cLive?.cls.includes('done') && playsWell(lPlay, 5.5), `${cLive?.stats} | ${JSON.stringify(lPlay)}`);
  await closeTarget(pL);

  // ================= K: nagrywanie przerwane zamknięciem menedżera → „Zapisz nagrane” =================
  liveReset({ step: 700 });
  const pL2 = await openPopup(tabL);
  await waitFor(() => evaluate(pL2.sessionId, `document.querySelector('.item .actions button.primary')?.textContent === '⏺ Nagrywaj' || null`), 8000);
  await evaluate(pL2.sessionId, `document.querySelector('.item .actions button.primary').click()`);
  await closeTarget(pL2);
  await until('/live/index.m3u8', /recording/, 10000);
  await sleep(3500);
  await closeTarget(mgr);
  await sleep(800);
  mgr = await openTarget(`chrome-extension://${extId}/manager.html`);
  const cInt = await until('/live/index.m3u8', /interrupted/, 10000);
  check(
    'po ponownym otwarciu: nagranie przerwane z „Zapisz nagrane” / „Nagrywaj dalej”',
    cInt?.cls.includes('interrupted') && cInt.buttons.includes('Zapisz nagrane') && cInt.buttons.includes('Nagrywaj dalej'),
    `${cInt?.status} [${cInt?.buttons}]`
  );
  const before = fs.readdirSync(chrome.downloads).filter((f) => f.startsWith('Transmisja')).length;
  await clickIn('/live/index.m3u8', 'Zapisz nagrane');
  const cSaved = await until('/live/index.m3u8', /done|error/, 30000);
  const savedName = await waitFor(() => fs.readdirSync(chrome.downloads).filter((f) => f.startsWith('Transmisja') && f.endsWith('.mp4')).length > before && fs.readdirSync(chrome.downloads).filter((f) => f.startsWith('Transmisja') && f.endsWith('.mp4')).sort().pop(), 10000);
  const savedPlay = savedName && (await play(savedName));
  check('„Zapisz nagrane” → MP4 z nagranym fragmentem', cSaved?.cls.includes('done') && playsWell(savedPlay, 3), `${savedName}: ${JSON.stringify(savedPlay)}`);
} catch (e) {
  check('przebieg testu', false, e.stack);
  console.log(chrome.stderr().slice(-3000));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  await chrome.close();
  server.close();
  process.exit(failed ? 1 : 0);
}
