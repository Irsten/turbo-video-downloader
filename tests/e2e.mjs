// Test rozszerzenia w prawdziwym Chrome: ładuje rozszerzenie do tymczasowego profilu
// (CDP przez pipe + Extensions.loadUnpacked, Chrome 126+) i sprawdza wykrywanie, licznik,
// popup, content.js i menedżer pobierania na lokalnych stronach testowych.
//
// Uruchom: npm run test:e2e
//   CHROME=ścieżka   – inny Chrome/Chromium (domyślnie szukany w typowych miejscach)
//   HEADFUL=1        – pokaż okno przeglądarki
//   KEEP=1           – nie usuwaj profilu i pobranych plików (ścieżka jest wypisywana)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, pages, state, resetCounters, DATA, SIZE } from './server.mjs';

const EXT_ROOT = process.env.EXT_ROOT || fileURLToPath(new URL('..', import.meta.url));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error('Nie znaleziono Chrome – podaj ścieżkę w zmiennej CHROME.');
    process.exit(2);
  }
  return found;
}
const CHROME = findChrome();
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tvd-e2e-'));
const PROFILE = path.join(WORK, 'profile');
const DL = path.join(WORK, 'downloads');
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(
  path.join(PROFILE, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true } })
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Na Windowsie pliki profilu bywają jeszcze chwilę zablokowane po zamknięciu Chrome. */
async function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  console.warn(`Nie udało się usunąć ${dir} (pliki wciąż zablokowane) – możesz go skasować ręcznie.`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  return last instanceof Error ? null : last;
}

// ---------------- CDP przez pipe ----------------
const proc = spawn(
  CHROME,
  [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${PROFILE}`,
    ...(process.env.HEADFUL ? [] : ['--headless=new']),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    'about:blank'
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
);
let stderr = '';
proc.stdio[2].on('data', (d) => (stderr += d));
const pipeWrite = proc.stdio[3];
const pipeRead = proc.stdio[4];
let msgId = 0;
const pending = new Map();
let buf = Buffer.alloc(0);
pipeRead.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
    buf = buf.subarray(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message + ' ' + (msg.error.data || ''))) : resolve(msg.result);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  pipeWrite.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function openTarget(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const { id: extId } = await send('Extensions.loadUnpacked', { path: EXT_ROOT });
  console.log('rozszerzenie:', extId);

  const swTarget = await waitFor(async () => {
    const { targetInfos } = await send('Target.getTargets');
    return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
  });
  const { sessionId: sw } = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  await evaluate(sw, '1');

  // ---------------- A: wykrywanie + licznik bez wariantów HLS ----------------
  pages['/video.html'] = `<!doctype html><html><head><meta charset="utf-8"><title>Film testowy A</title></head><body>
    <video id="v" src="/ok.mp4" preload="auto" muted></video>
    <a id="link" href="/nic.html">link</a><div id="feed"></div>
    <script>
      fetch('/hls/master.m3u8').then(r => r.text())
        .then(() => fetch('/hls/v720.m3u8')).then(r => r.text())
        .then(() => fetch('/hls/audio.m3u8')).then(r => r.text());
    </script></body></html>`;
  const page = await openTarget(`${base}/video.html`);
  const tabId = await waitFor(() =>
    evaluate(sw, `chrome.tabs.query({}).then(ts => ts.find(t => t.url?.includes('/video.html'))?.id)`)
  );
  const badge = () => evaluate(sw, `chrome.action.getBadgeText({ tabId: ${tabId} })`);
  const stored = () => evaluate(sw, `chrome.storage.session.get('tab:${tabId}').then(o => Object.values(o['tab:${tabId}'] || {}))`);

  await waitFor(async () => (await stored()).filter((i) => i.hls).length >= 3, 10000);
  const itemsA = await stored();
  const hlsInfo = itemsA.filter((i) => i.kind === 'hls').map((i) => `${i.url.split('/').pop()}:${i.hls?.kind}`);
  check('wykryto plik i 3 playlisty HLS', itemsA.length === 4, `${itemsA.length} pozycji; ${hlsInfo.join(', ')}`);
  const bA = await waitFor(async () => ((await badge()) === '2' ? '2' : null), 5000);
  check('licznik = 2 (MP4 + master), warianty HLS nie liczone', bA === '2', `licznik: "${await badge()}"`);

  // ---------------- C: content.js – tylko nowe elementy ----------------
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
    const urls = (await stored()).map((i) => i.url);
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
  const massOk = await waitFor(async () => (await stored()).some((i) => i.url === base + '/clip-mass.mp4'), 5000);
  check('content.js: masowa zmiana (>2000 węzłów) → pełny skan nadal wykrywa', !!massOk);
  const bC = await waitFor(async () => ((await badge()) === '6' ? '6' : null), 5000);
  check('licznik = 6 po dodaniu 4 filmów ze strony', bC === '6', `licznik: "${await badge()}"`);

  // ---------------- B: SPA ----------------
  await evaluate(page.sessionId, `history.pushState({}, '', '/video2.html'); document.title = 'Film B'; 1`);
  const bB = await waitFor(async () => ((await badge()) === '' ? 'empty' : null), 5000);
  check('SPA: po zmianie podstrony licznik = 0', bB === 'empty', `licznik: "${await badge()}"`);
  await evaluate(
    page.sessionId,
    `(() => { const v = document.createElement('video'); v.src = '/ok.mp4?v=2'; v.preload = 'auto'; v.muted = true; document.body.append(v); })()`
  );
  const bB2 = await waitFor(async () => ((await badge()) === '1' ? '1' : null), 6000);
  check('SPA: nowy film na nowej podstronie → licznik = 1', bB2 === '1', `licznik: "${await badge()}"`);

  // ---------------- popup (z podmienioną aktywną kartą) ----------------
  const tabObj = await evaluate(sw, `chrome.tabs.get(${tabId})`);
  const popup = await openTarget('about:blank');
  await send('Page.enable', {}, popup.sessionId);
  await send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: `if (location.protocol === 'chrome-extension:') chrome.tabs.query = async () => [${JSON.stringify(tabObj)}];` },
    popup.sessionId
  );
  await send('Page.navigate', { url: `chrome-extension://${extId}/popup.html` }, popup.sessionId);
  const popupState = await waitFor(async () => {
    const s = await evaluate(
      popup.sessionId,
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
  check(
    'popup: bieżąca podstrona = 1 film',
    popupState?.current.length === 1,
    JSON.stringify(popupState?.current)
  );
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

  // Zwykłe pobieranie wcześniejszego filmu → nazwa z tytułu strony, na której go wykryto.
  await evaluate(
    popup.sessionId,
    `(() => { const d = document.querySelector('details.earlier'); d.open = true;
      const item = [...d.querySelectorAll('.item')].find(e => e.querySelector('.name').title.endsWith('/ok.mp4'));
      item.querySelector('.actions button:not(.primary)').click(); })()`
  );
  const named = await waitFor(() => fs.readdirSync(DL).find((f) => f.startsWith('Film testowy A') && !f.endsWith('.crdownload')), 10000);
  check('popup: wcześniejszy film nazwany tytułem swojej podstrony', !!named, `plik: ${named || fs.readdirSync(DL).join(', ')}`);

  // ---------------- D: menedżer ----------------
  const mgr = await openTarget(`chrome-extension://${extId}/manager.html`);
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
      `(() => { const c = [...document.querySelectorAll('.job')].find(c => c.querySelector('.title').title.includes(${JSON.stringify(needle)}));
        return c && { cls: c.className, status: c.querySelector('.status').textContent, stats: c.querySelector('.stats').textContent,
          buttons: [...c.querySelectorAll('.buttons button')].map(b => b.textContent) }; })()`
    );

  let t = Date.now();
  await add(`${base}/expired.mp4`);
  const cExp = await waitFor(async () => ((await card('/expired.mp4'))?.cls.includes('error') ? card('/expired.mp4') : null), 10000);
  check('menedżer: strona HTML zamiast filmu → czytelny błąd', /stronę WWW/.test(cExp?.status || ''), `${Date.now() - t} ms: ${cExp?.status}`);

  t = Date.now();
  await add(`${base}/forbid.mp4`);
  const cFor = await waitFor(async () => ((await card('/forbid.mp4'))?.cls.includes('error') ? card('/forbid.mp4') : null), 15000);
  const msFor = Date.now() - t;
  check('menedżer: 403 → szybki błąd z podpowiedzią', /Brak dostępu \(HTTP 403\)/.test(cFor?.status || '') && msFor < 5000, `${msFor} ms: ${cFor?.status}`);

  state.flakyBudget = 7 * 1024 * 1024;
  resetCounters();
  await add(`${base}/flaky.mp4`);
  const cFl = await waitFor(async () => ((await card('/flaky.mp4'))?.cls.includes('error') ? card('/flaky.mp4') : null), 15000);
  check(
    'menedżer: po błędzie przycisk „Wznów” i informacja o zachowanych danych',
    cFl?.buttons.includes('Wznów') && /Zachowano/.test(cFl?.stats || ''),
    `${cFl?.status} | ${cFl?.stats} | [${cFl?.buttons}]`
  );
  await sleep(300);
  state.flakyBudget = Infinity;
  resetCounters();
  await evaluate(
    mgr.sessionId,
    `[...document.querySelectorAll('.job')].find(c => c.querySelector('.title').title.includes('/flaky.mp4'))
      .querySelector('.buttons button.primary').click()`
  );
  const cDone = await waitFor(async () => ((await card('/flaky.mp4'))?.cls.includes('done') ? card('/flaky.mp4') : null), 30000);
  const file = cDone && (await waitFor(() => fs.readdirSync(DL).find((f) => f.startsWith('flaky') && f.endsWith('.mp4')), 10000));
  const same = file && fs.readFileSync(path.join(DL, file)).equals(DATA);
  const refetched = (state.served['/flaky.mp4'] || 0) - 1;
  check('menedżer: „Wznów” kończy pobieranie, plik identyczny', !!same, `${cDone?.status}; plik ${file}`);
  check('menedżer: wznowienie nie pobiera od zera', refetched > 0 && refetched < SIZE, `drugi raz pobrano ${refetched} z ${SIZE} B`);

  t = Date.now();
  await add(`${base}/hls/master.m3u8`);
  const cH = await waitFor(async () => ((await card('/hls/master.m3u8'))?.cls.match(/done|error/) ? card('/hls/master.m3u8') : null), 20000);
  check('menedżer: HLS z osobnym audio nadal działa', cH?.cls.includes('done'), `${cH?.status} | ${cH?.stats}`);
} catch (e) {
  check('przebieg testu', false, e.stack);
  console.log(stderr.slice(-3000));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
  await Promise.race([send('Browser.close').catch(() => {}), sleep(3000)]);
  await Promise.race([exited, sleep(5000)]);
  proc.kill();
  server.close();
  if (process.env.KEEP) console.log('Profil i pobrane pliki:', WORK);
  else await removeDir(WORK);
  process.exit(failed ? 1 : 0);
}
