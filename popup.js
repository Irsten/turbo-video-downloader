import { formatBytes, formatDuration, sanitizeFilename, nameFromUrl, extFromMime, pageKey } from './lib/media.js';
import { parseM3U8, variantLabel } from './lib/hls.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { enqueue, openManager, newJobId } from './lib/jobs.js';

const $ = (s) => document.querySelector(s);
const listEl = $('#list');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const curPage = pageKey(tab?.url || '');
$('#page').textContent = tab?.title || tab?.url || '';

/** Film z innej podstrony tej karty (przejście w aplikacji SPA bez przeładowania). */
const isEarlier = (item) => !!item.page && item.page !== curPage;
/** Czy sekcja „Wcześniej na tej karcie” jest rozwinięta (null = domyślnie). */
let earlierOpen = null;

/** url playlisty -> Promise<parsed | {error}> */
const hlsCache = new Map();
/** url playlisty -> wybrana jakość (zachowana między odświeżeniami listy) */
const selections = new Map();

function analyzeHls(item) {
  if (!hlsCache.has(item.url)) {
    hlsCache.set(
      item.url,
      (async () => {
        try {
          await makePrepare(item.headers)(item.url);
          const res = await fetch(item.url, FETCH_INIT);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return parseM3U8(await res.text(), res.url || item.url);
        } catch (e) {
          return { error: e.message || String(e) };
        }
      })()
    );
  }
  return hlsCache.get(item.url);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function baseName(item) {
  // Wcześniejszy film nazywamy tytułem strony, na której go wykryto, a nie bieżącej.
  const title = isEarlier(item) ? item.title : tab?.title;
  return sanitizeFilename(title || '', '') || sanitizeFilename(nameFromUrl(item.url), 'film');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function startJob(job) {
  await enqueue({ id: newJobId(), createdAt: Date.now(), ...job });
  toast('Dodano do menedżera pobierania ⚡');
}

function renderFile(item) {
  // Puste = menedżer ustali rozszerzenie z Content-Type odpowiedzi.
  const ext = item.ext || extFromMime(item.mime) || '';
  const name = sanitizeFilename(nameFromUrl(item.url), 'film');
  const turbo = el(
    'button',
    {
      class: 'primary',
      title: 'Pobierz wieloma połączeniami naraz',
      onclick: () =>
        startJob({ kind: 'file', url: item.url, headers: item.headers, filename: baseName(item), ext, label: name })
    },
    '⚡ Pobierz'
  );
  const plain = el(
    'button',
    {
      title: 'Zwykłe pobieranie przez Operę (1 połączenie, bez nagłówków strony)',
      onclick: async () => {
        try {
          await chrome.downloads.download({
            url: item.url,
            filename: `${baseName(item)}.${ext || 'mp4'}`,
            conflictAction: 'uniquify'
          });
          toast('Przekazano do pobierania Opery');
        } catch (e) {
          toast('Błąd: ' + e.message);
        }
      }
    },
    '↓'
  );
  return el(
    'div',
    { class: 'item' },
    el('div', { class: 'name ellipsis', title: item.url }, name),
    el('div', { class: 'actions' }, turbo, plain),
    el(
      'div',
      { class: 'meta' },
      el('span', { class: 'badge' }, (ext || 'video').toUpperCase()),
      el('span', {}, item.size ? formatBytes(item.size) : 'rozmiar nieznany'),
      el('span', { class: 'muted ellipsis' }, hostOf(item.url))
    )
  );
}

function renderHls(item, info) {
  const name = sanitizeFilename(nameFromUrl(item.url), 'stream');
  const meta = el('div', { class: 'meta' }, el('span', { class: 'badge hls' }, 'HLS'));
  const actions = el('div', { class: 'actions' });
  const box = el(
    'div',
    { class: 'item' },
    el('div', { class: 'name ellipsis', title: item.url }, name),
    actions,
    meta
  );

  if (!info) {
    meta.append(el('span', { class: 'muted' }, 'analizuję playlistę…'));
    actions.append(el('button', { class: 'primary', disabled: '' }, '⚡ Pobierz'));
    return box;
  }

  const btn = el('button', { class: 'primary' }, '⚡ Pobierz');
  actions.append(btn);

  if (info.error) {
    meta.append(el('span', { class: 'muted' }, 'nie udało się odczytać playlisty – spróbuję mimo to'));
    btn.onclick = () =>
      startJob({ kind: 'hls', url: item.url, headers: item.headers, filename: baseName(item), label: name });
    return box;
  }

  if (info.encrypted) {
    btn.disabled = true;
    btn.textContent = '🔒 Zaszyfrowane';
    box.append(el('div', { class: 'note' }, 'Strumień chroniony (DRM / szyfrowanie) – nie do pobrania.'));
    return box;
  }

  if (info.kind === 'master') {
    if (!info.variants.length) {
      btn.disabled = true;
      meta.append(el('span', { class: 'muted' }, 'brak wariantów wideo'));
      return box;
    }
    const sel = el(
      'select',
      { title: 'Jakość', onchange: (e) => selections.set(item.url, e.target.value) },
      info.variants.map((v, i) => el('option', { value: String(i) }, variantLabel(v)))
    );
    if (selections.has(item.url)) sel.value = selections.get(item.url);
    actions.prepend(sel);
    meta.append(el('span', {}, `${info.variants.length} ${info.variants.length === 1 ? 'jakość' : 'jakości'}`));
    if (info.audios.some((a) => a.url)) meta.append(el('span', { class: 'muted' }, 'osobna ścieżka audio'));
    meta.append(el('span', { class: 'muted ellipsis' }, hostOf(item.url)));
    btn.onclick = () => {
      const v = info.variants[Number(sel.value)];
      const q = v.height ? ` [${v.height}p]` : '';
      startJob({
        kind: 'hls',
        url: item.url,
        variantUrl: v.url,
        headers: item.headers,
        filename: baseName(item) + q,
        label: `${name} · ${variantLabel(v)}`
      });
    };
    return box;
  }

  // playlista media (lista segmentów)
  meta.append(
    el('span', {}, formatDuration(info.duration)),
    el('span', { class: 'muted' }, `${info.segments.length} segmentów`)
  );
  if (!info.endList) meta.append(el('span', { class: 'badge dash' }, 'NA ŻYWO'));
  meta.append(el('span', { class: 'muted ellipsis' }, hostOf(item.url)));
  btn.onclick = () => startJob({ kind: 'hls', url: item.url, headers: item.headers, filename: baseName(item), label: name });
  return box;
}

function renderDash(item) {
  return el(
    'div',
    { class: 'item' },
    el('div', { class: 'name ellipsis', title: item.url }, sanitizeFilename(nameFromUrl(item.url), 'manifest')),
    el('div', { class: 'actions' }, el('button', { disabled: '' }, 'Nieobsługiwane')),
    el(
      'div',
      { class: 'meta' },
      el('span', { class: 'badge dash' }, 'DASH'),
      el('span', { class: 'muted' }, 'format .mpd nie jest jeszcze obsługiwany')
    )
  );
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { items = [] } = (await chrome.runtime.sendMessage({ type: 'get-media', tabId: tab.id })) || {};

  // Analiza HLS, żeby ukryć playlisty-warianty należące do wykrytej playlisty master.
  const hlsItems = items.filter((i) => i.kind === 'hls');
  const infos = new Map();
  const pending = hlsItems.map(async (i) => infos.set(i.url, await analyzeHls(i)));

  const draw = () => {
    if (seq !== renderSeq) return;
    const children = new Set();
    for (const info of infos.values()) {
      if (info?.kind === 'master') {
        info.variants.forEach((v) => children.add(v.url));
        info.audios.forEach((a) => a.url && children.add(a.url));
      }
    }
    const visible = items
      .filter((i) => !i.hidden) // części playlisty master rozpoznane już w tle
      .filter((i) => !(i.kind === 'hls' && children.has(i.url)))
      .filter((i) => !(i.kind === 'hls' && infos.get(i.url)?.kind === 'media' && !infos.get(i.url).segments.length))
      .sort((a, b) => {
        const rank = (x) => (x.kind === 'hls' ? (infos.get(x.url)?.kind === 'master' ? 0 : 1) : x.kind === 'file' ? 2 : 3);
        return rank(a) - rank(b) || (b.size || 0) - (a.size || 0);
      });

    const current = visible.filter((i) => !isEarlier(i));
    const earlier = visible.filter(isEarlier);
    const renderItem = (i) =>
      i.kind === 'file' ? renderFile(i) : i.kind === 'hls' ? renderHls(i, infos.get(i.url)) : renderDash(i);

    listEl.replaceChildren();
    if (!current.length) {
      listEl.append(
        el(
          'div',
          { class: 'empty' },
          el('b', {}, earlier.length ? 'Na tej podstronie nie wykryto jeszcze filmów.' : 'Nie wykryto jeszcze filmów na tej karcie.'),
          el('br'),
          'Uruchom odtwarzanie filmu – rozszerzenie wychwyci go z ruchu sieciowego. ',
          earlier.length ? null : 'Jeśli strona była otwarta przed instalacją rozszerzenia, odśwież ją.'
        )
      );
    }
    listEl.append(...current.map(renderItem));
    if (earlier.length) {
      const box = el(
        'details',
        { class: 'earlier', ontoggle: (e) => (earlierOpen = e.target.open) },
        el('summary', {}, `Wcześniej na tej karcie (${earlier.length})`),
        earlier.map(renderItem)
      );
      box.open = earlierOpen ?? !current.length;
      listEl.append(box);
    }
  };

  draw();
  for (const p of pending) p.then(draw);
}

$('#open-manager').onclick = () => openManager(true);
$('#clear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clear-media', tabId: tab.id });
  hlsCache.clear();
  render();
};

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes['tab:' + tab.id]) render();
});

render();
