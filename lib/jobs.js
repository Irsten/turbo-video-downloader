// Kolejka zadań: trzyma ją service worker (background.js), więc pobranie zadań
// przez menedżer jest atomowe, a menedżer otwiera się tylko w jednej karcie.

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
  connections: 6, // połączeń na plik (Range)
  hlsConcurrency: 8, // równoległych segmentów HLS
  maxParallel: 2, // ile pobrań naraz
  saveAs: false, // pytaj gdzie zapisać
  mp4: true // łącz obraz, dźwięk i segmenty w jeden plik MP4
};

/** Zadania zapisane przez menedżer (do wznowienia po restarcie). */
export const JOB_PREFIX = 'job:';

export async function unfinishedJobs() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v);
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
}
