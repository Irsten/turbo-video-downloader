// Service worker: wykrywa filmy w ruchu sieciowym kart i trzyma listę per karta.
import { classify, dedupeKey, urlExt, extFromMime, isBlockedHost, isHttp, pageKey, VIDEO_EXT } from './lib/media.js';
import { parseM3U8 } from './lib/hls.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';

const SELF_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const MEDIA_TYPES = ['media', 'xmlhttprequest', 'other', 'object'];
const MAX_ITEMS_PER_TAB = 150;
const MIN_FILE_SIZE = 256 * 1024; // mniejsze "filmy" to zwykle podglądy/fragmenty

/** tabId -> Map(key -> item) */
const tabs = new Map();
/** requestId -> { referer, origin } – nagłówki, z którymi strona pobierała media */
const reqHeaders = new Map();
/** Zadania czekające na menedżer pobierania. */
let jobQueue = [];

const ready = (async () => {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('tab:')) tabs.set(Number(k.slice(4)), new Map(Object.entries(v)));
    }
    jobQueue = all.jobQueue || [];
  } catch (e) {
    console.warn('Nie udało się wczytać stanu', e);
  }
})();

const persistQueue = () => chrome.storage.session.set({ jobQueue }).catch(() => {});

// ---------- menedżer pobierania (jedna karta) ----------
const MANAGER_URL = chrome.runtime.getURL('manager.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const managerContexts = () =>
  chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [MANAGER_URL] }).catch(() => []);

let managerChain = Promise.resolve();
/** Kolejkowane wywołania – dwa szybkie kliknięcia nie otworzą dwóch menedżerów. */
function ensureManager(focus) {
  const p = managerChain.then(async () => {
    let ctx = await managerContexts();
    if (!ctx.length) {
      await chrome.tabs.create({ url: MANAGER_URL, active: focus });
      for (let i = 0; i < 40 && !ctx.length; i++) {
        await sleep(100);
        ctx = await managerContexts();
      }
      return;
    }
    if (focus) {
      await chrome.tabs.update(ctx[0].tabId, { active: true });
      await chrome.windows.update(ctx[0].windowId, { focused: true }).catch(() => {});
    }
  });
  managerChain = p.catch(() => {});
  return p;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#e5243b' });
});

// ---------- zapis stanu ----------
const saveTimers = new Map();
function scheduleSave(tabId) {
  if (saveTimers.has(tabId)) return;
  saveTimers.set(
    tabId,
    setTimeout(() => {
      saveTimers.delete(tabId);
      const m = tabs.get(tabId);
      const key = 'tab:' + tabId;
      if (m && m.size) chrome.storage.session.set({ [key]: Object.fromEntries(m) }).catch(() => {});
      else chrome.storage.session.remove(key).catch(() => {});
      updateBadge(tabId);
    }, 150)
  );
}

/** Klucze pozycji, których popup nie pokazuje: jakości i audio z playlisty master, puste playlisty. */
function hiddenKeys(m) {
  const hidden = new Set();
  for (const it of m.values()) {
    for (const k of it.hls?.children || []) hidden.add(k);
    if (it.hls?.empty) hidden.add(it.key);
  }
  return hidden;
}

/** Licznik na ikonie = tyle filmów, ile popup pokaże dla bieżącej podstrony. */
async function updateBadge(tabId) {
  let n = 0;
  if (tabs.get(tabId)?.size) {
    const page = pageKey((await tabInfo(tabId)).url);
    const m = tabs.get(tabId);
    const hidden = m ? hiddenKeys(m) : new Set();
    for (const it of m?.values() || []) if (!hidden.has(it.key) && (!it.page || it.page === page)) n++;
  }
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

// ---------- analiza HLS ----------
// Odtwarzacz pobiera playlistę master, a potem playlisty jakości i audio – każda trafia na listę.
// Jedno pobranie playlisty mówi, które z nich to tylko części mastera (popup ich nie pokazuje).
const analyzing = new Set();

async function analyzeHls(tabId, item) {
  const id = tabId + ' ' + item.key;
  if (item.hls || analyzing.has(id)) return;
  analyzing.add(id);
  let hls = { kind: 'unknown' };
  try {
    await makePrepare(item.headers, { outsideTabs: true })(item.url);
    const res = await fetch(item.url, { ...FETCH_INIT, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const pl = parseM3U8(await res.text(), res.url || item.url);
      hls =
        pl.kind === 'master'
          ? {
              kind: 'master',
              children: [...pl.variants.map((v) => v.url), ...pl.audios.map((a) => a.url).filter(Boolean)].map(dedupeKey)
            }
          : { kind: 'media', empty: !pl.segments.length };
    }
  } catch {
    // nie udało się – pozycja zostaje widoczna, popup spróbuje sam
  } finally {
    analyzing.delete(id);
  }
  const cur = tabs.get(tabId)?.get(item.key);
  if (cur) {
    cur.hls = hls;
    scheduleSave(tabId);
  }
}

function clearTab(tabId) {
  if (!tabs.has(tabId)) return;
  tabs.delete(tabId);
  scheduleSave(tabId);
}

function addItem(tabId, item) {
  let m = tabs.get(tabId);
  if (!m) tabs.set(tabId, (m = new Map()));
  const prev = m.get(item.key);
  if (prev) {
    let changed = false;
    if (item.size && (!prev.size || item.size > prev.size)) (prev.size = item.size), (changed = true);
    if (item.mime && !prev.mime) (prev.mime = item.mime), (changed = true);
    if (item.headers.referer && !prev.headers.referer) (prev.headers = item.headers), (changed = true);
    // Film znów w użyciu (powrót na podstronę w aplikacji SPA, odtwarzacz w rogu) – przypisz go
    // do bieżącej podstrony.
    if (item.page && item.page !== prev.page) (prev.page = item.page), (changed = true);
    if (item.title && item.page === prev.page && item.title !== prev.title) (prev.title = item.title), (changed = true);
    if (changed) scheduleSave(tabId);
    if (prev.kind === 'hls' && !prev.hls) analyzeHls(tabId, prev);
    return;
  }
  if (m.size >= MAX_ITEMS_PER_TAB) return;
  m.set(item.key, item);
  scheduleSave(tabId);
  if (item.kind === 'hls') analyzeHls(tabId, item);
}

async function tabInfo(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { url: t.url || '', title: t.title || '' };
  } catch {
    return { url: '', title: '' };
  }
}

const isSelf = (d) => d.initiator === SELF_ORIGIN;

// ---------- nasłuch sieci ----------
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0 && d.frameId === 0) ready.then(() => clearTab(d.tabId));
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0 || isSelf(d)) return;
    let referer = '';
    let origin = '';
    for (const h of d.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === 'referer') referer = h.value || '';
      else if (n === 'origin') origin = h.value || '';
    }
    if (!referer && !origin) return;
    reqHeaders.set(d.requestId, { referer, origin });
    if (reqHeaders.size > 600) reqHeaders.delete(reqHeaders.keys().next().value);
  },
  { urls: ['<all_urls>'], types: MEDIA_TYPES },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    handleResponse(d).catch((e) => console.warn(e));
  },
  { urls: ['<all_urls>'], types: MEDIA_TYPES },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener((d) => reqHeaders.delete(d.requestId), {
  urls: ['<all_urls>'],
  types: MEDIA_TYPES
});

async function handleResponse(d) {
  const sent = reqHeaders.get(d.requestId);
  reqHeaders.delete(d.requestId);
  if (d.tabId < 0 || isSelf(d)) return;
  if (d.statusCode !== 200 && d.statusCode !== 206) return;

  let ct = '';
  let len = null;
  let rangeTotal = null;
  for (const h of d.responseHeaders || []) {
    const n = h.name.toLowerCase();
    if (n === 'content-type') ct = h.value || '';
    else if (n === 'content-length') len = Number(h.value) || null;
    else if (n === 'content-range') {
      const m = /\/(\d+)\s*$/.exec(h.value || '');
      if (m) rangeTotal = Number(m[1]);
    }
  }

  const kind = classify(d.url, ct);
  if (!kind) return;
  const size = rangeTotal || (d.statusCode === 200 ? len : null);
  if (kind === 'file' && size != null && size < MIN_FILE_SIZE) return;

  await ready;
  const tab = await tabInfo(d.tabId);
  addItem(d.tabId, {
    key: dedupeKey(d.url),
    url: d.url,
    kind,
    mime: ct,
    size,
    ext: VIDEO_EXT.includes(urlExt(d.url)) ? urlExt(d.url) : extFromMime(ct),
    headers: { referer: sent?.referer || tab.url, origin: sent?.origin || '' },
    page: pageKey(tab.url),
    title: tab.title,
    source: 'network',
    time: Date.now()
  });
}

// ---------- karty ----------
chrome.tabs.onRemoved.addListener((tabId) => ready.then(() => clearTab(tabId)));

// Zmiana adresu bez przeładowania (aplikacje SPA): lista zostaje, ale licznik ma liczyć filmy
// bieżącej podstrony – popup pokazuje wcześniejsze w osobnej, zwiniętej sekcji.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) ready.then(() => tabs.has(tabId) && updateBadge(tabId));
});

// ---------- wiadomości ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case 'enqueue': {
        jobQueue.push(msg.job);
        persistQueue();
        await ensureManager(false);
        chrome.runtime.sendMessage({ type: 'jobs-available' }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      case 'take-jobs': {
        // Synchronicznie: żaden inny handler nie wejdzie pomiędzy odczyt a wyczyszczenie.
        const jobs = jobQueue;
        jobQueue = [];
        persistQueue();
        sendResponse({ jobs });
        return;
      }
      case 'open-manager': {
        await ensureManager(!!msg.focus);
        sendResponse({ ok: true });
        return;
      }
      case 'dom-media': {
        sendResponse({ ok: true });
        const tabId = sender.tab?.id;
        if (tabId == null || tabId < 0) return;
        const page = pageKey(sender.tab.url || '');
        const tracks = [];
        for (const { url, tag, ...rest } of msg.items || []) {
          if (!isHttp(url) || isBlockedHost(url)) continue;
          if (tag === 'track') {
            tracks.push({ url, ...rest });
            continue;
          }
          const kind = classify(url) || (tag !== 'a' ? 'file' : null);
          if (!kind) continue;
          addItem(tabId, {
            key: dedupeKey(url),
            url,
            kind,
            mime: '',
            size: null,
            ext: VIDEO_EXT.includes(urlExt(url)) ? urlExt(url) : '',
            headers: { referer: sender.url || '', origin: '' },
            page,
            title: sender.tab.title || '',
            source: 'page',
            time: Date.now()
          });
        }
        // Napisy z <track> – dopinamy do filmu, w którym są osadzone.
        const m = tabs.get(tabId);
        for (const t of tracks) {
          const video = m?.get(dedupeKey(t.of || ''));
          if (!video) continue;
          video.subs ??= [];
          if (!video.subs.some((s) => s.url === t.url)) {
            video.subs.push({ url: t.url, lang: t.lang || '', label: t.label || '' });
            scheduleSave(tabId);
          }
        }
        return;
      }
      case 'get-media': {
        const m = tabs.get(msg.tabId);
        const hidden = m ? hiddenKeys(m) : new Set();
        sendResponse({ items: m ? [...m.values()].map((it) => ({ ...it, hidden: hidden.has(it.key) })) : [] });
        return;
      }
      case 'clear-media': {
        clearTab(msg.tabId);
        sendResponse({ ok: true });
        return;
      }
    }
  })();
  return true;
});
