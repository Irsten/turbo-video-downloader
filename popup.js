import { formatBytes, formatDuration, sanitizeFilename, nameFromUrl, extFromMime, pageKey } from './lib/media.js';
import { parseM3U8, variantLabel, audioOptions, subtitleOptions, mediaLabel } from './lib/hls.js';
import { parseMpd, representationLabel, dashAudioOptions } from './lib/dash.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { enqueue, openManager, newJobId, unfinishedJobs } from './lib/jobs.js';

const $ = (s) => document.querySelector(s);
const listEl = $('#list');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const curPage = pageKey(tab?.url || '');
$('#page').textContent = tab?.title || tab?.url || '';

/** Film z innej podstrony tej karty (przejście w aplikacji SPA bez przeładowania). */
const isEarlier = (item) => !!item.page && item.page !== curPage;
/** Czy sekcja „Wcześniej na tej karcie” jest rozwinięta (null = domyślnie). */
let earlierOpen = null;

/** url -> Promise<przeanalizowana playlista/manifest | {error}> */
const analysis = new Map();
/** url -> wybory użytkownika { v, a, s } (zachowane między odświeżeniami listy) */
const selections = new Map();
const sel = (url) => selections.get(url) || selections.set(url, {}).get(url);
let redraw = () => {};

async function fetchText(item, url) {
  await makePrepare(item.headers)(url);
  const res = await fetch(url, FETCH_INIT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), url: res.url || url };
}

function analyze(item) {
  if (!analysis.has(item.url)) {
    analysis.set(
      item.url,
      (async () => {
        try {
          if (item.kind === 'dash') {
            const r = await fetchText(item, item.url);
            return { kind: 'dash', ...parseMpd(r.text, r.url) };
          }
          const r = await fetchText(item, item.url);
          const pl = parseM3U8(r.text, r.url);
          if (pl.kind === 'master' && pl.variants.length) {
            // Czy to transmisja na żywo? Mówi o tym dopiero playlista wariantu.
            try {
              const v = await fetchText(item, pl.variants[0].url);
              pl.live = !parseM3U8(v.text, v.url).endList;
            } catch {
              pl.live = false;
            }
          } else if (pl.kind === 'media') pl.live = !pl.endList;
          return pl;
        } catch (e) {
          return { error: e.message || String(e) };
        }
      })()
    );
  }
  return analysis.get(item.url);
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

/** Lista wyboru; options: [[wartość, etykieta], …]. */
function select(title, options, value, onchange) {
  const s = el('select', { title, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => el('option', { value: v }, l)));
  if (value != null && options.some(([v]) => v === value)) s.value = value;
  return s;
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
  toast(job.record ? 'Nagrywanie rozpoczęte w menedżerze ⏺' : 'Dodano do menedżera pobierania ⚡');
  updateFooter();
}

/** Szkielet pozycji listy. */
function card(item, name, badge) {
  const meta = el('div', { class: 'meta' }, badge);
  const actions = el('div', { class: 'actions' });
  const opts = el('div', { class: 'opts' });
  const box = el('div', { class: 'item' }, el('div', { class: 'name ellipsis', title: item.url }, name), actions, meta, opts);
  return { box, meta, actions, opts };
}

/** Wybór napisów: '' = bez, 'all' = wszystkie, albo numer. */
function subtitlePicker(item, subs, label) {
  if (!subs.length) return null;
  const options = [['', 'Bez napisów'], ...subs.map((s, i) => [String(i), `Napisy: ${label(s)}`])];
  if (subs.length > 1) options.push(['all', 'Wszystkie napisy']);
  return select('Napisy (zapisane obok filmu jako .srt)', options, sel(item.url).s ?? '', (v) => (sel(item.url).s = v));
}
const chosenSubs = (item, subs) => {
  const v = sel(item.url).s ?? '';
  return v === 'all' ? subs : v === '' ? [] : [subs[Number(v)]].filter(Boolean);
};

function renderFile(item) {
  // Puste = menedżer ustali rozszerzenie z Content-Type odpowiedzi.
  const ext = item.ext || extFromMime(item.mime) || '';
  const name = sanitizeFilename(nameFromUrl(item.url), 'film');
  const { box, meta, actions, opts } = card(item, name, el('span', { class: 'badge' }, (ext || 'video').toUpperCase()));
  const subs = item.subs || [];
  const turbo = el(
    'button',
    {
      class: 'primary',
      title: 'Pobierz wieloma połączeniami naraz',
      onclick: () =>
        startJob({
          kind: 'file',
          url: item.url,
          headers: item.headers,
          filename: baseName(item),
          ext,
          label: name,
          subs: chosenSubs(item, subs)
        })
    },
    '⚡ Pobierz'
  );
  const plain = el(
    'button',
    {
      title: 'Zwykłe pobieranie przez przeglądarkę (1 połączenie, bez nagłówków strony)',
      onclick: async () => {
        try {
          await chrome.downloads.download({ url: item.url, filename: `${baseName(item)}.${ext || 'mp4'}`, conflictAction: 'uniquify' });
          toast('Przekazano do pobierania przeglądarki');
        } catch (e) {
          toast('Błąd: ' + e.message);
        }
      }
    },
    '↓'
  );
  actions.append(turbo, plain);
  meta.append(el('span', {}, item.size ? formatBytes(item.size) : 'rozmiar nieznany'), el('span', { class: 'muted ellipsis' }, hostOf(item.url)));
  const sp = subtitlePicker(item, subs, (s) => s.label || s.lang || 'napisy');
  if (sp) opts.append(sp);
  return box;
}

function renderHls(item, info) {
  const name = sanitizeFilename(nameFromUrl(item.url), 'stream');
  const { box, meta, actions, opts } = card(item, name, el('span', { class: 'badge hls' }, 'HLS'));
  if (!info) {
    meta.append(el('span', { class: 'muted' }, 'analizuję playlistę…'));
    actions.append(el('button', { class: 'primary', disabled: '' }, '⚡ Pobierz'));
    return box;
  }
  const btn = el('button', { class: 'primary' }, info.live ? '⏺ Nagrywaj' : '⚡ Pobierz');
  if (info.live) btn.title = 'Nagrywa transmisję, aż zatrzymasz ją w menedżerze pobierania';
  actions.append(btn);
  const base = { kind: 'hls', url: item.url, headers: item.headers, record: !!info.live };

  if (info.error) {
    meta.append(el('span', { class: 'muted' }, 'nie udało się odczytać playlisty – spróbuję mimo to'));
    btn.onclick = () => startJob({ ...base, filename: baseName(item), label: name });
    return box;
  }
  if (info.encrypted) {
    btn.disabled = true;
    btn.textContent = '🔒 Zaszyfrowane';
    box.append(el('div', { class: 'note' }, 'Strumień chroniony (DRM / szyfrowanie) – nie do pobrania.'));
    return box;
  }
  if (info.live) meta.append(el('span', { class: 'badge live' }, 'NA ŻYWO'));

  if (info.kind === 'master') {
    if (!info.variants.length) {
      btn.disabled = true;
      meta.append(el('span', { class: 'muted' }, 'brak wariantów wideo'));
      return box;
    }
    const s = sel(item.url);
    const variant = info.variants[Number(s.v ?? 0)] || info.variants[0];
    actions.prepend(
      select('Jakość', info.variants.map((v, i) => [String(i), variantLabel(v)]), s.v ?? '0', (v) => {
        s.v = v;
        redraw();
      })
    );
    const audios = audioOptions(info, variant);
    if (audios.length > 1) {
      opts.append(select('Ścieżka dźwiękowa', audios.map((a, i) => [String(i), `Audio: ${mediaLabel(a)}`]), s.a ?? '0', (v) => (s.a = v)));
    }
    const subs = info.live ? [] : subtitleOptions(info, variant);
    const sp = subtitlePicker(item, subs, mediaLabel);
    if (sp) opts.append(sp);
    meta.append(el('span', {}, `${info.variants.length} ${info.variants.length === 1 ? 'jakość' : 'jakości'}`));
    if (audios.length === 1) meta.append(el('span', { class: 'muted' }, 'osobna ścieżka audio'));
    meta.append(el('span', { class: 'muted ellipsis' }, hostOf(item.url)));
    btn.onclick = () => {
      const v = info.variants[Number(s.v ?? 0)] || info.variants[0];
      const a = audioOptions(info, v)[Number(s.a ?? 0)];
      const q = v.height ? ` [${v.height}p]` : '';
      startJob({
        ...base,
        variantUrl: v.url,
        audioUrl: a?.url,
        subtitles: chosenSubs(item, info.live ? [] : subtitleOptions(info, v)).map(({ url, name, language }) => ({ url, name, language })),
        filename: baseName(item) + q,
        label: `${name} · ${variantLabel(v)}${a && audioOptions(info, v).length > 1 ? ` · ${mediaLabel(a)}` : ''}`
      });
    };
    return box;
  }

  // playlista media (lista segmentów)
  if (!info.live) meta.append(el('span', {}, formatDuration(info.duration)));
  meta.append(el('span', { class: 'muted' }, `${info.segments.length} segmentów`), el('span', { class: 'muted ellipsis' }, hostOf(item.url)));
  btn.onclick = () => startJob({ ...base, filename: baseName(item), label: name });
  return box;
}

function renderDash(item, info) {
  const name = sanitizeFilename(nameFromUrl(item.url), 'manifest');
  const { box, meta, actions, opts } = card(item, name, el('span', { class: 'badge dash' }, 'DASH'));
  if (!info) {
    meta.append(el('span', { class: 'muted' }, 'analizuję manifest…'));
    actions.append(el('button', { class: 'primary', disabled: '' }, '⚡ Pobierz'));
    return box;
  }
  const btn = el('button', { class: 'primary' }, '⚡ Pobierz');
  actions.append(btn);
  if (info.error) {
    meta.append(el('span', { class: 'muted' }, 'nie udało się odczytać manifestu – spróbuję mimo to'));
    btn.onclick = () => startJob({ kind: 'dash', url: item.url, headers: item.headers, filename: baseName(item), label: name });
    return box;
  }
  if (info.dynamic) {
    btn.disabled = true;
    meta.append(el('span', { class: 'badge live' }, 'NA ŻYWO'));
    box.append(el('div', { class: 'note' }, 'Transmisje na żywo w formacie DASH nie są obsługiwane (HLS – tak).'));
    return box;
  }
  const videos = info.video.filter((r) => !r.encrypted);
  const audios = dashAudioOptions(info);
  if (!videos.length && !audios.length) {
    btn.disabled = true;
    btn.textContent = info.encrypted ? '🔒 Zaszyfrowane' : 'Brak ścieżek';
    if (info.encrypted) box.append(el('div', { class: 'note' }, 'Strumień chroniony (DRM) – nie do pobrania.'));
    return box;
  }
  const s = sel(item.url);
  if (videos.length) actions.prepend(select('Jakość', videos.map((r, i) => [String(i), representationLabel(r)]), s.v ?? '0', (v) => (s.v = v)));
  if (audios.length > 1) {
    opts.append(select('Ścieżka dźwiękowa', audios.map((r, i) => [String(i), `Audio: ${mediaLabel({ name: r.label, language: r.lang })}`]), s.a ?? '0', (v) => (s.a = v)));
  }
  const texts = info.text.filter((r) => r.container === 'vtt' && r.single);
  const sp = subtitlePicker(item, texts, (r) => mediaLabel({ name: r.label, language: r.lang }));
  if (sp) opts.append(sp);
  if (info.duration) meta.append(el('span', {}, formatDuration(info.duration)));
  if (videos.length > 1) meta.append(el('span', {}, `${videos.length} jakości`));
  if (info.multiPeriod) meta.append(el('span', { class: 'muted' }, 'tylko pierwsza część'));
  meta.append(el('span', { class: 'muted ellipsis' }, hostOf(item.url)));
  btn.onclick = () => {
    const v = videos[Number(s.v ?? 0)];
    const a = audios[Number(s.a ?? 0)];
    startJob({
      kind: 'dash',
      url: item.url,
      headers: item.headers,
      videoId: v?.id,
      audioId: a?.id,
      textIds: chosenSubs(item, texts).map((r) => r.id),
      filename: baseName(item) + (v?.height ? ` [${v.height}p]` : ''),
      label: `${name} · ${v ? representationLabel(v) : 'audio'}`
    });
  };
  return box;
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { items = [] } = (await chrome.runtime.sendMessage({ type: 'get-media', tabId: tab.id })) || {};

  // Analiza playlist/manifestów: jakości, audio, napisy, a przy HLS – ukrycie wariantów mastera.
  const infos = new Map();
  const pending = items.filter((i) => i.kind === 'hls' || i.kind === 'dash').map(async (i) => infos.set(i.url, await analyze(i)));

  const draw = () => {
    if (seq !== renderSeq) return;
    const children = new Set();
    for (const info of infos.values()) {
      if (info?.kind === 'master') {
        info.variants.forEach((v) => children.add(v.url));
        info.audios.forEach((a) => a.url && children.add(a.url));
        (info.subtitles || []).forEach((s) => children.add(s.url));
      }
    }
    const visible = items
      .filter((i) => !i.hidden) // części playlisty master rozpoznane już w tle
      .filter((i) => !(i.kind === 'hls' && children.has(i.url)))
      .filter((i) => !(i.kind === 'hls' && infos.get(i.url)?.kind === 'media' && !infos.get(i.url).segments.length))
      .sort((a, b) => {
        const rank = (x) => (x.kind === 'hls' ? (infos.get(x.url)?.kind === 'master' ? 0 : 1) : x.kind === 'dash' ? 0 : 2);
        return rank(a) - rank(b) || (b.size || 0) - (a.size || 0);
      });

    const current = visible.filter((i) => !isEarlier(i));
    const earlier = visible.filter(isEarlier);
    const renderItem = (i) =>
      i.kind === 'file' ? renderFile(i) : i.kind === 'hls' ? renderHls(i, infos.get(i.url)) : renderDash(i, infos.get(i.url));

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
  redraw = draw;

  draw();
  for (const p of pending) p.then(draw);
}

/** Licznik niedokończonych pobrań (przerwanych zamknięciem menedżera lub restartem). */
async function updateFooter() {
  const open = (await unfinishedJobs()).filter((j) => j.status !== 'done').length;
  $('#open-manager').textContent = open ? `Menedżer pobierania (${open})` : 'Menedżer pobierania';
  $('#open-manager').title = open ? `${open} niedokończonych pobrań – otwórz menedżer, żeby je wznowić` : '';
}

$('#open-manager').onclick = () => openManager(true);
$('#clear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clear-media', tabId: tab.id });
  analysis.clear();
  render();
};

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes['tab:' + tab.id]) render();
});

render();
updateFooter();
