// Service worker: wykrywa filmy w ruchu sieciowym kart i trzyma listę per karta.
import { classify, dedupeKey, urlExt, extFromMime, isBlockedHost, isHttp, VIDEO_EXT } from './lib/media.js';

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
      chrome.action.setBadgeText({ tabId, text: m && m.size ? String(m.size) : '' }).catch(() => {});
    }, 150)
  );
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
    if (changed) scheduleSave(tabId);
    return;
  }
  if (m.size >= MAX_ITEMS_PER_TAB) return;
  m.set(item.key, item);
  scheduleSave(tabId);
}

async function tabUrl(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).url || '';
  } catch {
    return '';
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
  const referer = sent?.referer || (await tabUrl(d.tabId));
  addItem(d.tabId, {
    key: dedupeKey(d.url),
    url: d.url,
    kind,
    mime: ct,
    size,
    ext: VIDEO_EXT.includes(urlExt(d.url)) ? urlExt(d.url) : extFromMime(ct),
    headers: { referer, origin: sent?.origin || '' },
    source: 'network',
    time: Date.now()
  });
}

// ---------- karty ----------
chrome.tabs.onRemoved.addListener((tabId) => ready.then(() => clearTab(tabId)));

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
        for (const { url, tag } of msg.items || []) {
          if (!isHttp(url) || isBlockedHost(url)) continue;
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
            source: 'page',
            time: Date.now()
          });
        }
        return;
      }
      case 'get-media': {
        const m = tabs.get(msg.tabId);
        sendResponse({ items: m ? [...m.values()] : [] });
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
