import { downloadFile, downloadHls, downloadDash, resumableBytes } from './lib/engine.js';
import { remuxToMp4, UnsupportedError } from './lib/remux.js';
import { DiskFile, MemoryFile, listDiskFiles, removeDiskFile } from './lib/store.js';
import { mergeVtt, parseVtt, toSrt } from './lib/subs.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { loadSettings, saveSettings, newJobId, takeJobs, JOB_PREFIX } from './lib/jobs.js';
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
  VIDEO_EXT
} from './lib/media.js';

const $ = (s, root = document) => root.querySelector(s);
const jobsEl = $('#jobs');

// ---------------- ustawienia ----------------
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
for (const key of ['saveAs', 'mp4']) {
  $('#' + key).checked = settings[key];
  $('#' + key).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings(settings);
  });
}

// ---------------- pliki robocze (OPFS) ----------------
let diskOk = true;
/** Plik roboczy zadania; na dysku, a gdyby OPFS był niedostępny – w pamięci (bez wznawiania po restarcie). */
async function openStoreFile(st, role) {
  const name = `${st.job.id}-${role}`;
  st.handles ??= new Map();
  if (st.handles.has(name)) return st.handles.get(name);
  let f;
  if (diskOk) {
    try {
      f = await DiskFile.open(name);
    } catch (e) {
      console.warn('OPFS niedostępny – zapis w pamięci', e);
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
    // OPFS niedostępny – nic do sprzątania
  }
}

// ---------------- zapis stanu zadań (wznawianie po restarcie) ----------------
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

// ---------------- kolejka ----------------
/** id -> stan zadania */
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
  // Nagrywanie transmisji nie zajmuje miejsca w limicie – trwa dowolnie długo i pobiera niewiele.
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

/** Odtwarza zadania zapisane przed zamknięciem menedżera / restartem przeglądarki. */
async function restoreJobs() {
  const all = await chrome.storage.local.get(null);
  const saved = Object.entries(all)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v)
    .filter((v) => v?.job?.id)
    .sort((a, b) => a.job.createdAt - b.job.createdAt);
  const ids = new Set(saved.map((v) => v.job.id));
  // Pliki robocze, do których nie należy żadne zadanie, to śmieci po usuniętych pobraniach.
  try {
    for (const name of await listDiskFiles()) if (!ids.has(name.split('-')[0])) await removeDiskFile(name);
  } catch {
    // brak OPFS
  }
  for (const v of saved) {
    let status = v.status;
    if (v.job.record && ['recording', 'running', 'queued'].includes(status)) status = 'interrupted';
    else if (['running', 'queued', 'processing', 'saving'].includes(status)) status = 'queued'; // dokończ automatycznie
    addJob(v.job, { status, error: v.error, resume: v.resume || {}, result: v.result || null, restored: true });
  }
}

// ---------------- pobieranie ----------------
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
    outputs: null
  });
  st.resume ||= {};
  update(st);
  persist(st, true);

  const signal = st.ctrl.signal;
  const prepare = makePrepare(job.headers || {});
  const openFile = (role) => openStoreFile(st, role);
  const onProgress = (p) => {
    if (p.resumed) st.samples = []; // odzyskane bajty to nie prędkość
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
    if (i.live && !i.recording) parts.push('transmisja na żywo – pobieram dostępny fragment');
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
        st.info = r.ranged ? `${r.connectionsUsed} połączeń równolegle` : 'serwer nie obsługuje zakresów – 1 połączenie';
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
        if (job.record) st.info = `nagranie ${formatDuration(r.duration)}`;
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
    }
    pump();
  }
}

/** Wynik z zapisanego stanu – „Zapisz nagrane” po przerwanym nagrywaniu (bez sieci). */
function resultFromState(st) {
  const tracks = [];
  for (const role of ['video', 'audio']) {
    const s = st.resume?.[role];
    if (!s?.order) continue;
    const parts = s.order.map((k) => s.index?.[k]).filter(Boolean);
    if (parts.length) tracks.push({ role, parts, ext: role === 'audio' ? 'aac' : 'ts' });
  }
  if (!tracks.length) throw new Error('Nic nie zostało nagrane');
  return { kind: 'segments', tracks, subtitles: [] };
}

/** Napisy z elementów <track> strony (małe pliki WebVTT). */
async function fetchTrackSubtitles(list, prepare, signal) {
  const out = [];
  for (const s of list) {
    try {
      await prepare(s.url);
      const res = await fetch(s.url, { ...FETCH_INIT, signal });
      if (res.ok) out.push({ name: s.label || '', language: s.lang || '', vtt: await res.text() });
    } catch (e) {
      if (signal.aborted) throw e;
      console.warn('Nie udało się pobrać napisów', s.url, e);
    }
  }
  return out;
}

const subtitleName = (s, i) => sanitizeFilename(s.language || s.name || '', '') || `napisy${i ? i + 1 : ''}`;

/** Składa pliki wynikowe (MP4 albo surowe ścieżki + napisy) i zapisuje je do folderu pobrań. */
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
    if (!inputs.length) throw new Error('Nic nie zostało pobrane');
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
        if (!(e instanceof UnsupportedError)) console.warn('Łączenie w MP4 nie powiodło się', e);
        st.note = `bez łączenia w MP4: ${e.message}`;
      }
    }
    if (mp4) {
      outputs.push({ blob: mp4.blob, name: `${base}.mp4` });
      start = mp4.start;
      st.info = [st.info, 'jeden plik MP4'].filter(Boolean).join(' · ');
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
      text: 'Obraz i dźwięk są w osobnych plikach. Połącz je bez utraty jakości:',
      code: `ffmpeg -i "${names[0]}" -i "${names[1]}" -c copy "${base} (pełny).mp4"`
    };
  if (names[0].endsWith('.ts'))
    return {
      text: 'Plik .ts odtworzysz w VLC / MPC-HC. Zamiana na .mp4 (bez utraty jakości, kilka sekund):',
      code: `ffmpeg -i "${names[0]}" -c copy "${base}.mp4"`
    };
  return null;
}

async function saveAll(st) {
  st.status = 'saving';
  update(st);
  try {
    while (st.outputs.length) {
      const f = st.outputs[0];
      st.downloadIds.push(await saveBlob(f.blob, f.name));
      st.outputs.shift();
    }
    st.status = 'done';
    st.total = st.loaded = st.total || st.loaded;
    await forget(st);
    st.resume = null;
    st.result = null;
    await removeStoreFiles(st);
  } catch (e) {
    st.status = 'unsaved';
    st.error = e?.message || String(e);
  }
}

async function saveBlob(blob, filename) {
  // Właściwy typ MIME – inaczej Opera potrafi zamienić np. .ts na .txt.
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
    if (id == null) throw new Error('Zapis anulowany');
    const { state, error } = await waitForDownload(id);
    if (state !== 'complete') throw new Error(error === 'USER_CANCELED' ? 'Zapis anulowany' : `Zapis nieudany (${error || state})`);
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

// ---------------- interfejs ----------------
const STATUS_TEXT = {
  queued: 'w kolejce',
  running: 'pobieranie…',
  recording: '⏺ nagrywanie…',
  paused: 'wstrzymane',
  interrupted: 'nagrywanie przerwane',
  processing: 'łączenie w MP4…',
  saving: 'zapisywanie na dysk…',
  done: 'gotowe ✓',
  error: 'błąd',
  unsaved: 'pobrane, niezapisane'
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
  if (st.status === 'processing' && st.progress) status = `łączenie w MP4… ${Math.round(st.progress * 100)}%`;
  $('.status', c).textContent = status + (st.error ? `: ${st.error}` : '');

  // pasek postępu
  const bar = $('.bar', c);
  const known = st.total && st.total > 0;
  let pct = known ? Math.min(100, (st.loaded / st.total) * 100) : 0;
  if (st.segs && st.status !== 'done') pct = (st.segs[0] / st.segs[1]) * 100;
  if (st.status === 'processing') pct = (st.progress || 0) * 100;
  if (st.status === 'done') pct = 100;
  const indeterminate = (st.status === 'running' && !known && !st.segs) || st.status === 'recording' || st.status === 'saving';
  bar.classList.toggle('indeterminate', indeterminate);
  $('div', bar).style.width = `${pct}%`;

  // statystyki: [etykieta, wartość] albo sam tekst
  const stats = [];
  if (st.status === 'running') {
    stats.push(['Pobrano', formatBytes(st.loaded) + (known ? ` z ${st.segs ? '~' : ''}${formatBytes(st.total)}` : '')]);
    stats.push(['Prędkość', `${formatBytes(st.speed)}/s`]);
    if (known && st.speed > 0) stats.push(['Pozostało', formatDuration(Math.max(0, st.total - st.loaded) / st.speed)]);
    if (st.segs) stats.push(['Segmenty', `${st.segs[0]}/${st.segs[1]}`]);
  } else if (st.status === 'recording') {
    stats.push(['Nagrano', formatDuration(st.recorded || 0)]);
    stats.push(['Pobrano', formatBytes(st.loaded)]);
    stats.push(['Prędkość', `${formatBytes(st.speed)}/s`]);
  } else if (['done', 'unsaved', 'saving'].includes(st.status) && st.elapsed) {
    stats.push(['Pobrano', formatBytes(st.loaded)]);
    stats.push(['Czas', formatDuration(st.elapsed)]);
    stats.push(['Średnio', `${formatBytes(st.loaded / Math.max(st.elapsed, 0.001))}/s`]);
  } else if (['error', 'paused', 'queued'].includes(st.status) && st.kept) {
    stats.push(['Zachowano', `${formatBytes(st.kept)} – „Wznów” dokończy pobieranie od tego miejsca`]);
  } else if (st.status === 'interrupted') {
    stats.push('Nagrany fragment jest na dysku – możesz go zapisać albo nagrywać dalej.');
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

  // podpowiedź
  const hint = $('.hint', c);
  hint.hidden = !(st.hint && (st.status === 'done' || st.status === 'unsaved'));
  if (!hint.hidden) {
    hint.textContent = st.hint.text;
    const code = document.createElement('code');
    code.textContent = st.hint.code;
    hint.append(code);
  }

  // przyciski
  const btns = $('.buttons', c);
  btns.replaceChildren();
  const requeue = () => {
    st.status = 'queued';
    st.error = null;
    update(st);
    persist(st, true);
    pump();
  };
  if (st.status === 'running') btns.append(button('Wstrzymaj', '', () => st.ctrl.abort(), 'Pobrane dane zostają na dysku'));
  if (st.status === 'recording') btns.append(button('⏹ Zatrzymaj i zapisz', 'primary', () => st.stop.abort()));
  if (st.status === 'paused' || st.status === 'error') btns.append(button(st.kept ? 'Wznów' : 'Ponów', 'primary', requeue));
  if (st.status === 'interrupted') {
    btns.append(button('Zapisz nagrane', 'primary', () => run(st, { finalizeOnly: true })));
    btns.append(button('Nagrywaj dalej', '', requeue));
  }
  if (st.status === 'unsaved')
    btns.append(
      button('Zapisz', 'primary', async () => {
        if (st.outputs?.length) {
          await saveAll(st);
          update(st);
        } else run(st, { finalizeOnly: true });
      })
    );
  if (st.status === 'done' && st.downloadIds?.length)
    btns.append(button('Pokaż w folderze', '', () => chrome.downloads.show(st.downloadIds[0])));
  if (!['processing', 'saving'].includes(st.status)) btns.append(button('✕', 'ghost', () => removeJob(st), 'Usuń (razem z pobranymi danymi)'));
}

function removeJob(st, ask = true) {
  const hasData = st.status !== 'done' && (st.kept || st.loaded || st.result);
  if (ask && hasData && !confirm('Usunąć to pobieranie razem z pobranymi danymi?')) return;
  st.removed = true;
  forget(st);
  st.el?.remove();
  jobs.delete(st.job.id);
  if (BUSY.has(st.status)) st.ctrl?.abort(); // pliki usunie kończące się run()
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
    empty.textContent = 'Brak pobrań. Kliknij ikonę rozszerzenia na stronie z filmem i wybierz „⚡ Pobierz”.';
    jobsEl.append(empty);
  }
}

// Prędkość: średnia z ostatnich ~3 s, odświeżanie 2× na sekundę.
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
}, 500);

$('#clear-finished').addEventListener('click', () => {
  for (const st of [...jobs.values()]) if (st.status === 'done' || (st.status === 'error' && !st.kept)) removeJob(st, false);
});

$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#add-url').value.trim();
  const kind = classify(url) || 'file';
  const ext = urlExt(url);
  const name = sanitizeFilename(nameFromUrl(url), 'film');
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
await restoreJobs();
takeQueued();
