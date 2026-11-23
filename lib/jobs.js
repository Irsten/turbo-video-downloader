// Job queue: kept by the service worker (background.js), so the manager takes jobs
// atomically and the manager opens in one tab only.

export function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function enqueue(job) {
  return chrome.runtime.sendMessage({ type: 'enqueue', job });
}

export function openManager(focus) {
  return chrome.runtime.sendMessage({ type: 'open-manager', focus: !!focus });
}

export async function takeJobs() {
  const r = await chrome.runtime.sendMessage({ type: 'take-jobs' });
  return r?.jobs || [];
}

export const DEFAULT_SETTINGS = {
  connections: 6, // connections per file (Range)
  hlsConcurrency: 8, // parallel HLS/DASH segments
  maxParallel: 2, // downloads at once
  saveAs: false, // ask where to save
  mp4: true, // merge video, audio and segments into one MP4 file
  template: '{title} [{quality}]', // file name template (see applyTemplate in media.js)
  notify: true // notification when done, if the manager is in the background
};

// ---------- download history ----------
const HISTORY_KEY = 'history';
const HISTORY_MAX = 200;

export async function loadHistory() {
  const { [HISTORY_KEY]: h } = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(h) ? h : [];
}

export async function saveHistory(list) {
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, HISTORY_MAX) });
}

export async function addHistory(entry) {
  const list = await loadHistory();
  await saveHistory([entry, ...list.filter((e) => e.id !== entry.id)]);
}

/** Jobs saved by the manager (to be resumed after a restart). */
export const JOB_PREFIX = 'job:';

export async function unfinishedJobs() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v);
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // The default template of older versions used Polish variable names – show the English one instead.
  if (s.template === '{tytuł} [{jakość}]') s.template = DEFAULT_SETTINGS.template;
  return s;
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
}
