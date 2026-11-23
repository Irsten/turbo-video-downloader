import { downloadFile, downloadHls, resumableBytes } from './lib/engine.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { loadSettings, saveSettings, newJobId, takeJobs } from './lib/jobs.js';
import { variantLabel } from './lib/hls.js';
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
$('#saveAs').checked = settings.saveAs;
$('#saveAs').addEventListener('change', (e) => {
  settings.saveAs = e.target.checked;
  saveSettings(settings);
});

// ---------------- kolejka ----------------
/** id -> stan zadania */
const jobs = new Map();
const ACTIVE = new Set(['running', 'saving']);

function addJob(job) {
  if (jobs.has(job.id)) return;
  // resume: pobrane fragmenty/segmenty – „Wznów” po błędzie lub anulowaniu nie zaczyna od zera.
  const st = { job, status: 'queued', loaded: 0, total: null, samples: [], speed: 0, resume: {}, kept: 0 };
  jobs.set(job.id, st);
  createCard(st);
  update(st);
  pump();
}

async function takeQueued() {
  (await takeJobs()).forEach(addJob);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'jobs-available') takeQueued();
});

function pump() {
  let free = settings.maxParallel - [...jobs.values()].filter((s) => ACTIVE.has(s.status)).length;
  for (const st of jobs.values()) {
    if (free <= 0) break;
    if (st.status === 'queued') {
      free--;
      run(st);
    }
  }
  renderEmpty();
}

// ---------------- pobieranie ----------------
async function run(st) {
  const { job } = st;
  Object.assign(st, {
    status: 'running',
    error: null,
    hint: null,
    info: '',
    segs: null,
    loaded: 0,
    total: null,
    samples: [],
    speed: 0,
    kept: 0,
    resume: st.resume || {},
    startedAt: performance.now(),
    ctrl: new AbortController(),
    downloadIds: []
  });
  update(st);

  const signal = st.ctrl.signal;
  const prepare = makePrepare(job.headers || {});
  const onProgress = (p) => {
    if (p.resumed) st.samples = []; // odzyskane bajty to nie prędkość
    st.loaded = p.loaded;
    st.total = p.total;
    if (p.segmentsTotal) st.segs = [p.segmentsDone, p.segmentsTotal];
  };

  try {
    if (job.kind === 'file') {
      const r = await downloadFile(job.url, {
        connections: settings.connections,
        signal,
        onProgress,
        prepare,
        fetchInit: FETCH_INIT,
        resume: st.resume
      });
      st.info = r.ranged ? `${r.connectionsUsed} połączeń równolegle` : 'serwer nie obsługuje zakresów – 1 połączenie';
      const ext = job.ext || extFromMime(r.contentType) || 'mp4';
      st.files = [{ blob: r.blob, name: `${job.filename}.${ext}` }];
    } else {
      const r = await downloadHls(job.url, {
        variantUrl: job.variantUrl,
        concurrency: settings.hlsConcurrency,
        signal,
        onProgress,
        prepare,
        fetchInit: FETCH_INIT,
        resume: st.resume,
        onInfo: (i) => {
          const parts = [];
          if (i.variant) parts.push(variantLabel(i.variant));
          if (i.duration) parts.push(formatDuration(i.duration));
          if (i.live) parts.push('transmisja na żywo – pobieram dostępny fragment');
          st.info = parts.join(' · ');
        }
      });
      const base = job.filename;
      st.files = [{ blob: r.video.blob, name: `${base}.${r.video.ext}` }];
      if (r.audio) {
        const a = `${base} (audio).${r.audio.ext}`;
        st.files.push({ blob: r.audio.blob, name: a });
        st.hint = {
          text: 'Obraz i dźwięk są w osobnych plikach (tak nadaje serwis). Połącz je bez utraty jakości:',
          code: `ffmpeg -i "${base}.${r.video.ext}" -i "${a}" -c copy "${base} (pełny).mp4"`
        };
      } else if (r.video.ext === 'ts') {
        st.hint = {
          text: 'Plik .ts odtworzysz w VLC / MPC-HC. Zamiana na .mp4 (bez utraty jakości, kilka sekund):',
          code: `ffmpeg -i "${base}.ts" -c copy "${base}.mp4"`
        };
      }
    }
    st.resume = null; // gotowe – fragmenty są już w pliku
    st.elapsed = (performance.now() - st.startedAt) / 1000;
    st.total = st.files.reduce((n, f) => n + f.blob.size, 0);
    st.loaded = st.total;
    await saveAll(st);
  } catch (e) {
    if (signal.aborted) st.status = 'canceled';
    else {
      st.status = 'error';
      st.error = e?.message || String(e);
      console.error(e);
    }
    st.kept = resumableBytes(st.resume);
  } finally {
    update(st);
    pump();
  }
}

async function saveAll(st) {
  st.status = 'saving';
  update(st);
  try {
    while (st.files.length) {
      const f = st.files[0];
      st.downloadIds.push(await saveBlob(f.blob, f.name));
      st.files.shift(); // zapisany – zwolnij pamięć
    }
    st.status = 'done';
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
  saving: 'zapisywanie na dysk…',
  done: 'gotowe ✓',
  error: 'błąd',
  canceled: 'anulowano',
  unsaved: 'pobrane, niezapisane'
};

function button(label, cls, onclick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
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
  $('.status', c).textContent = STATUS_TEXT[st.status] + (st.error ? `: ${st.error}` : '');

  // pasek postępu
  const bar = $('.bar', c);
  const known = st.total && st.total > 0;
  const pct = st.status === 'done' ? 100 : known ? Math.min(100, (st.loaded / st.total) * 100) : 0;
  const segPct = st.segs ? (st.segs[0] / st.segs[1]) * 100 : null;
  bar.classList.toggle('indeterminate', (st.status === 'running' && !known && segPct == null) || st.status === 'saving');
  $('div', bar).style.width = `${segPct != null && st.status !== 'done' ? segPct : pct}%`;

  // statystyki: [etykieta, wartość] albo sam tekst
  const stats = [];
  if (st.status === 'running') {
    stats.push(['Pobrano', formatBytes(st.loaded) + (known ? ` z ${st.segs ? '~' : ''}${formatBytes(st.total)}` : '')]);
    stats.push(['Prędkość', `${formatBytes(st.speed)}/s`]);
    if (known && st.speed > 0) stats.push(['Pozostało', formatDuration(Math.max(0, st.total - st.loaded) / st.speed)]);
    if (st.segs) stats.push(['Segmenty', `${st.segs[0]}/${st.segs[1]}`]);
  } else if ((st.status === 'done' || st.status === 'unsaved' || st.status === 'saving') && st.elapsed) {
    stats.push(['Rozmiar', formatBytes(st.total)]);
    stats.push(['Czas', formatDuration(st.elapsed)]);
    stats.push(['Średnio', `${formatBytes(st.total / Math.max(st.elapsed, 0.001))}/s`]);
  } else if ((st.status === 'error' || st.status === 'canceled') && st.kept) {
    stats.push(['Zachowano', `${formatBytes(st.kept)} – „Wznów” dokończy pobieranie od tego miejsca`]);
  }
  if (st.info) stats.push(st.info);
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
  if (st.status === 'queued') btns.append(button('Anuluj', '', () => removeJob(st)));
  if (st.status === 'running') btns.append(button('Anuluj', '', () => st.ctrl.abort()));
  if (st.status === 'unsaved')
    btns.append(
      button('Zapisz', 'primary', async () => {
        await saveAll(st);
        update(st);
      })
    );
  if (st.status === 'error' || st.status === 'canceled')
    btns.append(
      button(st.kept ? 'Wznów' : 'Ponów', 'primary', () => {
        st.status = 'queued';
        st.error = null;
        update(st);
        pump();
      })
    );
  if (st.status === 'done' && st.downloadIds?.length)
    btns.append(button('Pokaż w folderze', '', () => chrome.downloads.show(st.downloadIds[0])));
  if (!ACTIVE.has(st.status) && st.status !== 'queued') btns.append(button('✕', 'ghost', () => removeJob(st)));
}

function removeJob(st) {
  st.ctrl?.abort();
  st.files = null;
  st.resume = null; // zwolnij zachowane fragmenty
  st.el?.remove();
  jobs.delete(st.job.id);
  renderEmpty();
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
    if (st.status !== 'running') continue;
    st.samples.push([now, st.loaded]);
    while (st.samples.length > 2 && now - st.samples[0][0] > 3000) st.samples.shift();
    const [t0, b0] = st.samples[0];
    st.speed = now - t0 > 0 ? Math.max(0, ((st.loaded - b0) * 1000) / (now - t0)) : 0;
    update(st);
  }
}, 500);

$('#clear-finished').addEventListener('click', () => {
  for (const st of [...jobs.values()]) if (['done', 'error', 'canceled'].includes(st.status)) removeJob(st);
});

$('#add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#add-url').value.trim();
  const kind = classify(url) || 'file';
  if (kind === 'dash') return alert('Format DASH (.mpd) nie jest jeszcze obsługiwany.');
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
  if ([...jobs.values()].some((s) => ACTIVE.has(s.status) || s.status === 'queued')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

renderEmpty();
takeQueued();
