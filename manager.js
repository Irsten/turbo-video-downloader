import { downloadFile, downloadHls, downloadDash, resumableBytes } from './lib/engine.js';
import { remuxToMp4, UnsupportedError } from './lib/remux.js';
import { DiskFile, MemoryFile, listDiskFiles, removeDiskFile } from './lib/store.js';
import { mergeVtt, parseVtt, toSrt } from './lib/subs.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { loadSettings, saveSettings, newJobId, takeJobs, JOB_PREFIX, loadHistory, saveHistory, addHistory } from './lib/jobs.js';
import { variantLabel } from './lib/hls.js';
import { representationLabel } from './lib/dash.js';
import {
  formatBytes,
  formatDuration,
  sanitizeFilename,
  nameFromUrl,
  extFromMime,
  urlExt,
  classify,
  mimeForExt,
  applyTemplate,
  hostOf,
  DEFAULT_TEMPLATE,
  TEMPLATE_HELP,
  VIDEO_EXT
} from './lib/media.js';

const $ = (s, root = document) => root.querySelector(s);
const jobsEl = $('#jobs');
const TITLE = document.title;

// ---------------- settings ----------------
let settings = await loadSettings();
const LIMITS = { connections: [1, 16], hlsConcurrency: [1, 32], maxParallel: [1, 6] };
for (const [key, [min, max]] of Object.entries(LIMITS)) {
  const inp = $('#' + key);
  inp.value = settings[key];
  inp.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, parseInt(inp.value, 10) || settings[key]));
    inp.value = v;
    settings[key] = v;
    saveSettings(settings);
    pump();
  });
}
for (const key of ['saveAs', 'mp4', 'notify']) {
  $('#' + key).checked = settings[key];
  $('#' + key).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings(settings);
  });
}
// File name template (used by the popup and the context menu).
const tplInput = $('#template');
const tplPreview = () =>
  ($('#template-preview').textContent =
    'e.g. "' + applyTemplate(tplInput.value, { title: 'Cat video', quality: '720p', file: 'video', host: 'example.com' }) + '"');
tplInput.value = settings.template || DEFAULT_TEMPLATE;
tplInput.placeholder = DEFAULT_TEMPLATE;
tplInput.title = TEMPLATE_HELP;
tplInput.addEventListener('input', tplPreview);
tplInput.addEventListener('change', () => {
  settings.template = tplInput.value.trim() || DEFAULT_TEMPLATE;
  tplInput.value = settings.template;
  saveSettings(settings);
  tplPreview();
});
tplPreview();

// ---------------- working files (OPFS) ----------------
let diskOk = true;
/** A job's working file; on disk, or – if OPFS were unavailable – in memory (no resuming after a restart). */
async function openStoreFile(st, role) {
  const name = `${st.job.id}-${role}`;
  st.handles ??= new Map();
  if (st.handles.has(name)) return st.handles.get(name);
  let f;
  if (diskOk) {
    try {
      f = await DiskFile.open(name);
    } catch (e) {
      console.warn('OPFS unavailable – keeping data in memory', e);
      diskOk = false;
    }
  }
  f ??= new MemoryFile();
  st.handles.set(name, f);
  return f;
}

async function removeStoreFiles(st) {
  const prefix = st.job.id + '-';
  st.handles = null;
  try {
    for (const name of await listDiskFiles()) if (name.startsWith(prefix)) await removeDiskFile(name);
  } catch {
    // OPFS unavailable – nothing to clean up
  }
}

// ---------------- saving job state (resuming after a restart) ----------------
const persistTimers = new Map();
function snapshot(st) {
  return {
    job: st.job,
    status: st.status,
    error: st.error || null,
    resume: st.resume || null,
    result: st.result || null
  };
}
function persist(st, now = false) {
  if (st.removed || st.status === 'done') return;
  const write = () => {
    persistTimers.delete(st.job.id);
    if (st.removed || st.status === 'done') return;
    chrome.storage.local.set({ [JOB_PREFIX + st.job.id]: snapshot(st) }).catch(() => {});
  };
  if (now) {
    clearTimeout(persistTimers.get(st.job.id));
    return write();
  }
  if (!persistTimers.has(st.job.id)) persistTimers.set(st.job.id, setTimeout(write, 1000));
}
function forget(st) {
  clearTimeout(persistTimers.get(st.job.id));
  persistTimers.delete(st.job.id);
  return chrome.storage.local.remove(JOB_PREFIX + st.job.id).catch(() => {});
}

// ---------------- queue ----------------
/** id -> job state */
const jobs = new Map();
const ACTIVE = new Set(['running', 'processing', 'saving']);
const BUSY = new Set([...ACTIVE, 'recording']);

function addJob(job, restored = null) {
  if (jobs.has(job.id)) return;
  const st = {
    job,
    status: 'queued',
    loaded: 0,
    total: null,
    samples: [],
    speed: 0,
    resume: {},
    result: null,
    kept: 0,
    ...restored
  };
  st.kept = resumableBytes(st.resume);
  st.loaded = st.kept;
  jobs.set(job.id, st);
  createCard(st);
  update(st);
  persist(st, true);
  pump();
}

async function takeQueued() {
  (await takeJobs()).forEach((j) => addJob(j));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'jobs-available') takeQueued();
});

function pump() {
  // Live recordings don't take a slot in the limit – they last arbitrarily long and download little.
  let free = settings.maxParallel - [...jobs.values()].filter((s) => ACTIVE.has(s.status)).length;
  for (const st of [...jobs.values()].sort((a, b) => a.job.createdAt - b.job.createdAt)) {
    if (st.status !== 'queued') continue;
    if (st.job.record) {
      run(st);
      continue;
    }
    if (free <= 0) continue;
    free--;
    run(st);
  }
  renderEmpty();
}

/** Restores jobs saved before the manager was closed / the browser restarted. */
async function restoreJobs() {
  const all = await chrome.storage.local.get(null);
  const saved = Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v)
    .filter((v) => v?.job?.id)
    .sort((a, b) => a.job.createdAt - b.job.createdAt);
  const ids = new Set(saved.map((v) => v.job.id));
  // Working files that no job owns are leftovers of removed downloads.
  try {
    for (const name of await listDiskFiles()) if (!ids.has(name.split('-')[0])) await removeDiskFile(name);
  } catch {
    // no OPFS
  }
  for (const v of saved) {
    let status = v.status;
    if (v.job.record && ['recording', 'running', 'queued'].includes(status)) status = 'interrupted';
    else if (['running', 'queued', 'processing', 'saving'].includes(status)) status = 'queued'; // finish automatically
    addJob(v.job, { status, error: v.error, resume: v.resume || {}, result: v.result || null, restored: true });
  }
}

// ---------------- downloading ----------------
async function run(st, { finalizeOnly = false } = {}) {
  const { job } = st;
  Object.assign(st, {
    status: job.record && !finalizeOnly && !st.result ? 'recording' : 'running',
    error: null,
    hint: null,
    note: null,
    info: '',
    segs: null,
    loaded: resumableBytes(st.resume),
    total: null,
    samples: [],
    speed: 0,
    recorded: 0,
    kept: 0,
    startedAt: performance.now(),
    ctrl: new AbortController(),
    stop: job.record ? new AbortController() : null,
    downloadIds: [],
    saved: [],
    outputs: null
  });
  st.resume ||= {};
  update(st);
  persist(st, true);

  const signal = st.ctrl.signal;
  const prepare = makePrepare(job.headers || {});
  const openFile = (role) => openStoreFile(st, role);
  const onProgress = (p) => {
    if (p.resumed) st.samples = []; // recovered bytes are not speed
    st.loaded = p.loaded;
    st.total = p.total;
    if (p.segmentsTotal) st.segs = [p.segmentsDone, p.segmentsTotal];
    if (p.recorded != null) st.recorded = p.recorded;
    persist(st);
  };
  const onInfo = (i) => {
    const parts = [];
    if (i.variant) parts.push(job.kind === 'dash' ? representationLabel(i.variant) : variantLabel(i.variant));
    if (i.audioTrack && (i.audioTrack.language || i.audioTrack.lang)) parts.push(`audio: ${(i.audioTrack.language || i.audioTrack.lang).toUpperCase()}`);
    if (i.duration && !i.recording) parts.push(formatDuration(i.duration));
    if (i.live && !i.recording) parts.push('live stream – downloading the part available now');
    st.info = parts.join(' · ');
  };

  try {
    if (finalizeOnly && !st.result) st.result = resultFromState(st);
    if (!st.result) {
      if (job.kind === 'file') {
        const file = await openFile('file');
        const r = await downloadFile(job.url, {
          file,
          resume: st.resume,
          connections: settings.connections,
          signal,
          onProgress,
          prepare,
          fetchInit: FETCH_INIT
        });
        st.info = r.ranged ? `${r.connectionsUsed} parallel connections` : "the server doesn't support ranges – 1 connection";
        const subtitles = await fetchTrackSubtitles(job.subs || [], prepare, signal);
        st.result = { kind: 'file', ext: job.ext || extFromMime(r.contentType) || 'mp4', subtitles };
      } else if (job.kind === 'dash') {
        const r = await downloadDash(job.url, {
          videoId: job.videoId,
          audioId: job.audioId,
          textIds: job.textIds || [],
          openFile,
          resume: st.resume,
          connections: settings.connections,
          concurrency: settings.hlsConcurrency,
          signal,
          onProgress,
          onInfo,
          prepare,
          fetchInit: FETCH_INIT
        });
        st.result = { kind: 'segments', tracks: r.tracks, subtitles: r.subtitles };
      } else {
        const r = await downloadHls(job.url, {
          variantUrl: job.variantUrl,
          audioUrl: job.audioUrl,
          subtitles: job.subtitles || [],
          record: !!job.record,
          stopSignal: st.stop?.signal,
          openFile,
          resume: st.resume,
          concurrency: settings.hlsConcurrency,
          signal,
          onProgress,
          onInfo,
          prepare,
          fetchInit: FETCH_INIT
        });
        st.result = { kind: 'segments', tracks: r.tracks, subtitles: r.subtitles };
        if (job.record) st.info = `recording ${formatDuration(r.duration)}`;
      }
      st.elapsed = (performance.now() - st.startedAt) / 1000;
      persist(st, true);
    }
    await finalize(st);
  } catch (e) {
    if (st.removed) return;
    if (signal.aborted) st.status = 'paused';
    else {
      st.status = 'error';
      st.error = e?.message || String(e);
      console.error(e);
    }
    st.kept = resumableBytes(st.resume);
  } finally {
    if (st.removed) await removeStoreFiles(st);
    else {
      update(st);
      persist(st, true);
      notify(st);
    }
    pump();
  }
}

/** Notification at the end of a download – only when the manager is in the background (otherwise it's visible anyway). */
function notify(st) {
  if (!settings.notify || !document.hidden || !['done', 'error', 'unsaved'].includes(st.status)) return;
  const done = st.status === 'done';
  chrome.notifications
    .create(done ? `tvd-done:${st.downloadIds[0]}` : `tvd-err:${st.job.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: done ? 'Video downloaded' : 'Download failed',
      message: done ? st.saved?.[0]?.name || st.job.filename : `${st.job.label || st.job.filename}: ${st.error || ''}`,
      contextMessage: done ? `${formatBytes(st.saved.reduce((n, f) => n + f.size, 0))} · click to show in folder` : 'click to open the manager'
    })
    .catch(() => {});
}

// ---------------- progress on the extension icon and in the tab title ----------------
const ICONS = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
let iconBase = null;
let lastIndicator = '';
let lastIconAt = 0;
async function updateIndicator() {
  const busy = [...jobs.values()].filter((s) => BUSY.has(s.status));
  let loaded = 0;
  let total = 0;
  let recording = false;
  for (const s of busy) {
    if (s.status === 'recording') recording = true;
    else if (s.total > 0) {
      loaded += Math.min(s.loaded, s.total);
      total += s.total;
    }
  }
  const pct = total ? Math.floor((loaded / total) * 100) : null;
  document.title = busy.length ? `${pct != null ? pct + '%' : '⏺'} · ${TITLE}` : TITLE;
  const key = busy.length ? `${pct}|${recording}` : 'idle';
  // Refresh every now and then even without changes – the background restores the icon after the manager closes.
  if (key === lastIndicator && Date.now() - lastIconAt < 5000) return;
  lastIndicator = key;
  lastIconAt = Date.now();
  if (!busy.length) return chrome.action.setIcon({ path: ICONS }).catch(() => {});
  iconBase ??= Promise.all([16, 32].map(async (n) => createImageBitmap(await (await fetch(`icons/icon${n}.png`)).blob())));
  const bases = await iconBase;
  const imageData = {};
  [16, 32].forEach((n, i) => {
    const g = new OffscreenCanvas(n, n).getContext('2d');
    g.drawImage(bases[i], 0, 0, n, n);
    const h = n === 16 ? 4 : 7;
    g.fillStyle = 'rgba(0, 0, 0, 0.8)';
    g.fillRect(0, n - h, n, h);
    g.fillStyle = '#3ccf7a';
    g.fillRect(1, n - h + 1, Math.round(((n - 2) * (pct ?? 0)) / 100), h - 2);
    if (recording) {
      g.fillStyle = '#ff3d4f';
      g.beginPath();
      g.arc(n * 0.8, n * 0.2, n * 0.2, 0, Math.PI * 2);
      g.fill();
    }
    imageData[n] = g.getImageData(0, 0, n, n);
  });
  chrome.action.setIcon({ imageData }).catch(() => {});
}

// ---------------- history ----------------
const historyEl = $('#history');
const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

async function renderHistory() {
  const list = await loadHistory();
  historyEl.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Finished downloads will appear here.';
    historyEl.append(empty);
    return;
  }
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'entry';
    const name = document.createElement('div');
    name.className = 'name ellipsis';
    name.textContent = e.name + (e.files.length > 1 ? `  (+${e.files.length - 1})` : '');
    name.title = [...e.files, e.url].join('\n');
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `${formatBytes(e.size)} · ${hostOf(e.page || e.url)} · ${timeFmt.format(e.finishedAt)}`;
    const show = button('Show', '', () => chrome.downloads.show(e.downloadIds[0]), 'Show the file in its folder');
    show.disabled = true;
    chrome.downloads.search({ id: e.downloadIds[0] }).then(([d]) => {
      const ok = d && d.state === 'complete' && d.exists !== false;
      show.disabled = !ok;
      if (!ok) show.title = 'The file is no longer on disk';
    });
    const again = button('Download again', '', () => addJob({ ...e.job, id: newJobId(), createdAt: Date.now() }), 'Add the same download once more');
    const del = button('✕', 'ghost', async () => {
      await saveHistory((await loadHistory()).filter((x) => x.id !== e.id));
      renderHistory();
    }, 'Remove from history (the file stays on disk)');
    row.append(name, when, show, again, del);
    historyEl.append(row);
  }
}
$('#clear-history').addEventListener('click', async () => {
  await saveHistory([]);
  renderHistory();
});

/** Result from the saved state – "Save recording" after an interrupted recording (no network). */
function resultFromState(st) {
  const tracks = [];
  for (const role of ['video', 'audio']) {
    const s = st.resume?.[role];
    if (!s?.order) continue;
    const parts = s.order.map((k) => s.index?.[k]).filter(Boolean);
    if (parts.length) tracks.push({ role, parts, ext: role === 'audio' ? 'aac' : 'ts' });
  }
  if (!tracks.length) throw new Error('Nothing has been recorded');
  return { kind: 'segments', tracks, subtitles: [] };
}

/** Subtitles from the page's <track> elements (small WebVTT files). */
async function fetchTrackSubtitles(list, prepare, signal) {
  const out = [];
  for (const s of list) {
    try {
      await prepare(s.url);
      const res = await fetch(s.url, { ...FETCH_INIT, signal });
      if (res.ok) out.push({ name: s.label || '', language: s.lang || '', vtt: await res.text() });
    } catch (e) {
      if (signal.aborted) throw e;
      console.warn('Could not download subtitles', s.url, e);
    }
  }
  return out;
}

const subtitleName = (s, i) => sanitizeFilename(s.language || s.name || '', '') || `subtitles${i ? i + 1 : ''}`;

/** Builds the output files (MP4 or raw tracks + subtitles) and saves them to the downloads folder. */
async function finalize(st) {
  const res = st.result;
  const base = st.job.filename;
  const outputs = [];
  let start = null;
  st.status = 'processing';
  st.progress = 0;
  update(st);
  if (res.kind === 'file') {
    outputs.push({ blob: await (await openStoreFile(st, 'file')).blob(), name: `${base}.${res.ext}` });
  } else {
    const inputs = [];
    for (const t of res.tracks) {
      if (!t.parts.length) continue;
      inputs.push({ ...t, blob: await (await openStoreFile(st, t.role)).blob() });
    }
    if (!inputs.length) throw new Error('Nothing has been downloaded');
    let mp4 = null;
    if (settings.mp4) {
      try {
        const scratch = await openStoreFile(st, 'mux');
        await scratch.truncate(0);
        mp4 = await remuxToMp4(inputs, {
          scratch,
          onProgress: (f) => {
            st.progress = f;
            update(st);
          }
        });
      } catch (e) {
        if (!(e instanceof UnsupportedError)) console.warn('Merging into MP4 failed', e);
        st.note = `not merged into MP4: ${e.message}`;
      }
    }
    if (mp4) {
      outputs.push({ blob: mp4.blob, name: `${base}.mp4` });
      start = mp4.start;
      st.info = [st.info, 'one MP4 file'].filter(Boolean).join(' · ');
    } else {
      const names = inputs.map((t) => (t.role === 'audio' && inputs.length > 1 ? `${base} (audio).${t.ext}` : `${base}.${t.ext}`));
      inputs.forEach((t, i) => outputs.push({ blob: new Blob(t.parts.map(([p, s]) => t.blob.slice(p, p + s))), name: names[i] }));
      st.hint = rawHint(names, base);
    }
  }
  (res.subtitles || []).forEach((s, i) => {
    const cues = s.segments ? mergeVtt(s.segments, start) : parseVtt(s.vtt || '').cues;
    if (cues.length) outputs.push({ blob: new Blob([toSrt(cues)], { type: 'application/x-subrip' }), name: `${base}.${subtitleName(s, i)}.srt` });
  });
  st.outputs = outputs;
  await saveAll(st);
}

function rawHint(names, base) {
  if (names.length > 1)
    return {
      text: 'Video and audio are in separate files. Merge them without quality loss:',
      code: `ffmpeg -i "${names[0]}" -i "${names[1]}" -c copy "${base} (full).mp4"`
    };
  if (names[0].endsWith('.ts'))
    return {
      text: 'Play the .ts file in VLC / MPC-HC. Converting to .mp4 (no quality loss, a few seconds):',
      code: `ffmpeg -i "${names[0]}" -c copy "${base}.mp4"`
    };
  return null;
}

async function saveAll(st) {
  st.status = 'saving';
  update(st);
  try {
    st.saved ??= [];
    while (st.outputs.length) {
      const f = st.outputs[0];
      const id = await saveBlob(f.blob, f.name);
      st.downloadIds.push(id);
      st.saved.push({ name: (await chrome.downloads.search({ id }))[0]?.filename?.split(/[\\/]/).pop() || f.name, size: f.blob.size });
      st.outputs.shift();
    }
    st.status = 'done';
    st.total = st.loaded = st.total || st.loaded;
    await forget(st);
    st.resume = null;
    st.result = null;
    await removeStoreFiles(st);
    await addHistory({
      id: st.job.id,
      name: st.saved[0]?.name || st.job.filename,
      files: st.saved.map((f) => f.name),
      size: st.saved.reduce((n, f) => n + f.size, 0),
      finishedAt: Date.now(),
      url: st.job.url,
      page: st.job.headers?.referer || '',
      downloadIds: st.downloadIds,
      job: { ...st.job, record: st.job.record || undefined }
    });
    renderHistory();
  } catch (e) {
    st.status = 'unsaved';
    st.error = e?.message || String(e);
  }
}

async function saveBlob(blob, filename) {
  // The right MIME type – otherwise Opera may turn e.g. .ts into .txt.
  const typed = new Blob([blob], { type: mimeForExt(filename.split('.').pop()) });
  const url = URL.createObjectURL(typed);
  try {
    let id;
    try {
      id = await chrome.downloads.download({ url, filename, saveAs: settings.saveAs, conflictAction: 'uniquify' });
    } catch (e) {
      if (!/filename/i.test(e.message || '')) throw e;
      const ext = filename.split('.').pop();
      id = await chrome.downloads.download({ url, filename: `video.${ext}`, saveAs: settings.saveAs, conflictAction: 'uniquify' });
    }
    if (id == null) throw new Error('Saving canceled');
    const { state, error } = await waitForDownload(id);
    if (state !== 'complete') throw new Error(error === 'USER_CANCELED' ? 'Saving canceled' : `Saving failed (${error || state})`);
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

function waitForDownload(id) {
  return new Promise((resolve) => {
    const finish = (state, error) => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve({ state, error });
    };
    const listener = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete' || d.state.current === 'interrupted') finish(d.state.current, d.error?.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([d]) => {
      if (d && (d.state === 'complete' || d.state === 'interrupted')) finish(d.state, d.error);
    });
  });
}

// ---------------- user interface ----------------
const STATUS_TEXT = {
  queued: 'queued',
  running: 'downloading…',
  recording: '⏺ recording…',
  paused: 'paused',
  interrupted: 'recording interrupted',
  processing: 'merging into MP4…',
  saving: 'saving to disk…',
  done: 'done ✓',
  error: 'error',
  unsaved: 'downloaded, not saved'
};

function button(label, cls, onclick, title) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener('click', onclick);
  return b;
}

function createCard(st) {
  const card = document.createElement('div');
  card.className = 'job';
  card.innerHTML = `
    <div class="top">
      <div class="title ellipsis"></div>
      <div class="status"></div>
      <div class="buttons"></div>
    </div>
    <div class="bar"><div></div></div>
    <div class="stats"></div>
    <div class="hint" hidden></div>`;
  $('.title', card).textContent = st.job.label || st.job.filename;
  $('.title', card).title = st.job.url;
  st.el = card;
  jobsEl.prepend(card);
}

function update(st) {
  const c = st.el;
  if (!c) return;
  c.className = `job ${st.status}`;
  let status = STATUS_TEXT[st.status];
  if (st.status === 'processing' && st.progress) status = `merging into MP4… ${Math.round(st.progress * 100)}%`;
  $('.status', c).textContent = status + (st.error ? `: ${st.error}` : '');

  // progress bar
  const bar = $('.bar', c);
  const known = st.total && st.total > 0;
  let pct = known ? Math.min(100, (st.loaded / st.total) * 100) : 0;
  if (st.segs && st.status !== 'done') pct = (st.segs[0] / st.segs[1]) * 100;
  if (st.status === 'processing') pct = (st.progress || 0) * 100;
  if (st.status === 'done') pct = 100;
  const indeterminate = (st.status === 'running' && !known && !st.segs) || st.status === 'recording' || st.status === 'saving';
  bar.classList.toggle('indeterminate', indeterminate);
  $('div', bar).style.width = `${pct}%`;

  // stats: [label, value] or plain text
  const stats = [];
  if (st.status === 'running') {
    stats.push(['Downloaded', formatBytes(st.loaded) + (known ? ` of ${st.segs ? '~' : ''}${formatBytes(st.total)}` : '')]);
    stats.push(['Speed', `${formatBytes(st.speed)}/s`]);
    if (known && st.speed > 0) stats.push(['Remaining', formatDuration(Math.max(0, st.total - st.loaded) / st.speed)]);
    if (st.segs) stats.push(['Segments', `${st.segs[0]}/${st.segs[1]}`]);
  } else if (st.status === 'recording') {
    stats.push(['Recorded', formatDuration(st.recorded || 0)]);
    stats.push(['Downloaded', formatBytes(st.loaded)]);
    stats.push(['Speed', `${formatBytes(st.speed)}/s`]);
  } else if (['done', 'unsaved', 'saving'].includes(st.status) && st.elapsed) {
    stats.push(['Downloaded', formatBytes(st.loaded)]);
    stats.push(['Time', formatDuration(st.elapsed)]);
    stats.push(['Average', `${formatBytes(st.loaded / Math.max(st.elapsed, 0.001))}/s`]);
  } else if (['error', 'paused', 'queued'].includes(st.status) && st.kept) {
    stats.push(['Kept', `${formatBytes(st.kept)} – "Resume" will continue the download from here`]);
  } else if (st.status === 'interrupted') {
    stats.push('The recorded part is on disk – you can save it or keep recording.');
  }
  if (st.info) stats.push(st.info);
  if (st.note) stats.push(st.note);
  $('.stats', c).replaceChildren(
    ...stats.map((s) => {
      const span = document.createElement('span');
      if (typeof s === 'string') span.textContent = s;
      else {
        const b = document.createElement('b');
        b.textContent = s[1];
        span.append(s[0] + ' ', b);
      }
      return span;
    })
  );

  // hint
  const hint = $('.hint', c);
  hint.hidden = !(st.hint && (st.status === 'done' || st.status === 'unsaved'));
  if (!hint.hidden) {
    hint.textContent = st.hint.text;
    const code = document.createElement('code');
    code.textContent = st.hint.code;
    hint.append(code);
  }

  // buttons
  const btns = $('.buttons', c);
  btns.replaceChildren();
  const requeue = () => {
    st.status = 'queued';
    st.error = null;
    update(st);
    persist(st, true);
    pump();
  };
  if (st.status === 'running') btns.append(button('Pause', '', () => st.ctrl.abort(), 'Downloaded data stays on disk'));
  if (st.status === 'recording') btns.append(button('⏹ Stop and save', 'primary', () => st.stop.abort()));
  if (st.status === 'paused' || st.status === 'error') btns.append(button(st.kept ? 'Resume' : 'Retry', 'primary', requeue));
  if (st.status === 'interrupted') {
    btns.append(button('Save recording', 'primary', () => run(st, { finalizeOnly: true })));
    btns.append(button('Keep recording', '', requeue));
  }
  if (st.status === 'unsaved')
    btns.append(
      button('Save', 'primary', async () => {
        if (st.outputs?.length) {
          await saveAll(st);
          update(st);
        } else run(st, { finalizeOnly: true });
      })
    );
  if (st.status === 'done' && st.downloadIds?.length)
    btns.append(button('Show in folder', '', () => chrome.downloads.show(st.downloadIds[0])));
  if (!['processing', 'saving'].includes(st.status)) btns.append(button('✕', 'ghost', () => removeJob(st), 'Remove (together with the downloaded data)'));
}

function removeJob(st, ask = true) {
  const hasData = st.status !== 'done' && (st.kept || st.loaded || st.result);
  if (ask && hasData && !confirm('Remove this download together with the downloaded data?')) return;
  st.removed = true;
  forget(st);
  st.el?.remove();
  jobs.delete(st.job.id);
  if (BUSY.has(st.status)) st.ctrl?.abort(); // the finishing run() removes the files
  else removeStoreFiles(st);
  renderEmpty();
  pump();
}

function renderEmpty() {
  let empty = $('.empty', jobsEl);
  if (jobs.size) return empty?.remove();
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No downloads. Click the extension icon on a page with a video and choose "⚡ Download".';
    jobsEl.append(empty);
  }
}

// Speed: average over the last ~3 s, refreshed twice a second.
setInterval(() => {
  const now = performance.now();
  for (const st of jobs.values()) {
    if (st.status !== 'running' && st.status !== 'recording') continue;
    st.samples.push([now, st.loaded]);
    while (st.samples.length > 2 && now - st.samples[0][0] > 3000) st.samples.shift();
    const [t0, b0] = st.samples[0];
    st.speed = now - t0 > 0 ? Math.max(0, ((st.loaded - b0) * 1000) / (now - t0)) : 0;
    update(st);
  }
  updateIndicator();
}, 500);

$('#clear-finished').addEventListener('click', () => {
  for (const st of [...jobs.values()]) if (st.status === 'done' || (st.status === 'error' && !st.kept)) removeJob(st, false);
});

$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#add-url').value.trim();
  const kind = classify(url) || 'file';
  const ext = urlExt(url);
  const name = sanitizeFilename(nameFromUrl(url), 'video');
  addJob({
    id: newJobId(),
    createdAt: Date.now(),
    kind,
    url,
    headers: {},
    filename: name,
    ext: VIDEO_EXT.includes(ext) ? ext : '',
    label: name
  });
  $('#add-url').value = '';
});

window.addEventListener('beforeunload', (e) => {
  if ([...jobs.values()].some((s) => BUSY.has(s.status))) {
    e.preventDefault();
    e.returnValue = '';
  }
});

renderEmpty();
renderHistory();
await restoreJobs();
takeQueued();
