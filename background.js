// Service worker: detects videos in the tabs' network traffic and keeps a list per tab.
import {
  classify,
  dedupeKey,
  urlExt,
  extFromMime,
  isBlockedHost,
  isHttp,
  pageKey,
  applyTemplate,
  nameFromUrl,
  hostOf,
  VIDEO_EXT
} from './lib/media.js';
import { parseM3U8 } from './lib/hls.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { loadSettings, newJobId } from './lib/jobs.js';
import { tr } from './lib/i18n.js';
import { pageVideoCount, revealFile } from './lib/external.js';

const SELF_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const MEDIA_TYPES = ['media', 'xmlhttprequest', 'other', 'object'];
const MAX_ITEMS_PER_TAB = 150;
const MIN_FILE_SIZE = 256 * 1024; // smaller "videos" are usually previews/fragments

/** tabId -> Map(key -> item) */
const tabs = new Map();
/** requestId -> { referer, origin } – headers the page used when fetching media */
const reqHeaders = new Map();
/** Jobs waiting for the download manager. */
let jobQueue = [];
/** tabId -> { page, og, videos: { key: { src, stream, poster, duration, height } } } – thumbnails and durations */
const pageInfo = new Map();

const ready = (async () => {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('tab:')) tabs.set(Number(k.slice(4)), new Map(Object.entries(v)));
      else if (k.startsWith('info:')) pageInfo.set(Number(k.slice(5)), v);
    }
    jobQueue = all.jobQueue || [];
  } catch (e) {
    console.warn('Could not load the saved state', e);
  }
})();

const persistQueue = () => chrome.storage.session.set({ jobQueue }).catch(() => {});

// ---------- download manager (a single tab) ----------
const MANAGER_URL = chrome.runtime.getURL('manager.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const managerContexts = () =>
  chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [MANAGER_URL] }).catch(() => []);

let managerChain = Promise.resolve();
/** Queued calls – two quick clicks won't open two managers. */
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

/** A job for the manager (popup, context menu). */
async function enqueueJob(job) {
  jobQueue.push(job);
  persistQueue();
  await ensureManager(false);
  chrome.runtime.sendMessage({ type: 'jobs-available' }).catch(() => {});
}

// ---------- context menu ----------
const VIDEO_LINKS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'm3u8', 'mpd'].map((e) => `*://*/*.${e}*`);

/** (Re)creates the context menu – also on browser start, so its titles follow the current browser language. */
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'tvd-video', title: tr('ctxVideo'), contexts: ['video'] });
    chrome.contextMenus.create({ id: 'tvd-link', title: tr('ctxLink'), contexts: ['link'], targetUrlPatterns: VIDEO_LINKS });
  });
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#e5243b' });
  createMenus();
});
chrome.runtime.onStartup.addListener(createMenus);

/** Download from the context menu: a link or the source of a <video>. */
async function downloadFromContext(info, tab) {
  await ready;
  const url = info.menuItemId === 'tvd-link' ? info.linkUrl : info.srcUrl;
  if (!isHttp(url) || isBlockedHost(url)) {
    // Video played from a stream (blob:/MediaSource) – only the list of detected videos knows its address.
    await chrome.action.openPopup().catch(() =>
      chrome.notifications.create('tvd-hint', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: tr('extName'),
        message: tr('hintStream')
      })
    );
    return null;
  }
  const settings = await loadSettings();
  const known = tab?.id >= 0 ? tabs.get(tab.id)?.get(dedupeKey(url)) : null;
  const ext = urlExt(url);
  const job = {
    id: newJobId(),
    createdAt: Date.now(),
    kind: classify(url) || 'file',
    url,
    headers: known?.headers || { referer: info.pageUrl || tab?.url || '', origin: '' },
    filename: applyTemplate(settings.template, { title: tab?.title || '', file: nameFromUrl(url), host: hostOf(info.pageUrl || tab?.url) }),
    ext: VIDEO_EXT.includes(ext) ? ext : known?.ext || '',
    label: nameFromUrl(url) || hostOf(url)
  };
  await enqueueJob(job);
  return job;
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  downloadFromContext(info, tab).catch((e) => console.warn(e));
});
globalThis.tvdDownloadFromContext = downloadFromContext; // for tests (the context menu can't be clicked over CDP)

// ---------- notifications and icon ----------
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  const done = /^tvd-done:(\d+)$/.exec(id);
  const file = /^tvd-file:(.+)$/.exec(id); // saved by the helper program
  if (done) chrome.downloads.show(Number(done[1]));
  else if (file) revealFile(decodeURIComponent(file[1]));
  else ensureManager(true);
});

/** After the manager is closed the icon goes back to normal (no progress bar). */
async function resetIconIfIdle() {
  if (!(await managerContexts()).length) {
    chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } }).catch(() => {});
  }
}

// ---------- saving state ----------
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

/** Keys of items the popup doesn't show: qualities and audio of a master playlist, empty playlists. */
function hiddenKeys(m) {
  const hidden = new Set();
  for (const it of m.values()) {
    for (const k of it.hls?.children || []) hidden.add(k);
    if (it.hls?.empty) hidden.add(it.key);
  }
  return hidden;
}

/** Badge on the icon = as many videos as the popup will show for the current sub-page. */
async function updateBadge(tabId) {
  const { url } = await tabInfo(tabId);
  let n = pageVideoCount(url); // a YouTube video page (personal build)
  const m = tabs.get(tabId);
  if (m?.size) {
    const page = pageKey(url);
    const hidden = hiddenKeys(m);
    for (const it of m.values()) if (!hidden.has(it.key) && (!it.page || it.page === page)) n++;
  }
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

// ---------- HLS analysis ----------
// The player fetches the master playlist, then the quality and audio playlists – each one lands on the list.
// A single fetch of a playlist tells which of them are only parts of the master (the popup hides them).
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
    // failed – the item stays visible, the popup will try on its own
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
  if (pageInfo.delete(tabId)) chrome.storage.session.remove('info:' + tabId).catch(() => {});
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
    if (item.size && (!prev.size || item.size > prev.size)) {
      prev.size = item.size;
      changed = true;
    }
    if (item.mime && !prev.mime) {
      prev.mime = item.mime;
      changed = true;
    }
    if (item.headers.referer && !prev.headers.referer) {
      prev.headers = item.headers;
      changed = true;
    }
    // The video is in use again (back to a sub-page in an SPA, mini player) – assign it
    // to the current sub-page.
    if (item.page && item.page !== prev.page) {
      prev.page = item.page;
      changed = true;
    }
    if (item.title && item.page === prev.page && item.title !== prev.title) {
      prev.title = item.title;
      changed = true;
    }
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

// ---------- network listeners ----------
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

// ---------- tabs ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => clearTab(tabId));
  resetIconIfIdle();
});

// Address change without a reload (SPA): the list stays, but the badge should count the videos
// of the current sub-page – the popup shows the earlier ones in a separate, collapsed section.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) ready.then(() => updateBadge(tabId));
});

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case 'enqueue': {
        await enqueueJob(msg.job);
        sendResponse({ ok: true });
        return;
      }
      case 'page-info': {
        sendResponse({ ok: true });
        const tabId = sender.tab?.id;
        if (tabId == null || tabId < 0) return;
        const page = pageKey(sender.tab.url || '');
        let info = pageInfo.get(tabId);
        if (!info || info.page !== page) pageInfo.set(tabId, (info = { page, og: '', videos: {} }));
        if (msg.og && sender.frameId === 0) info.og = msg.og;
        (msg.videos || []).forEach((v, i) => {
          if (Object.keys(info.videos).length >= 40) return;
          info.videos[v.src ? dedupeKey(v.src) : `stream:${sender.frameId}:${i}`] = v;
        });
        chrome.storage.session.set({ ['info:' + tabId]: info }).catch(() => {});
        return;
      }
      case 'take-jobs': {
        // Synchronously: no other handler can get in between reading and clearing.
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
        // Subtitles from <track> – attached to the video they are embedded in.
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
        sendResponse({
          items: m ? [...m.values()].map((it) => ({ ...it, hidden: hidden.has(it.key) })) : [],
          info: pageInfo.get(msg.tabId) || null
        });
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
