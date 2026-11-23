import { formatBytes, formatDuration, sanitizeFilename, nameFromUrl, extFromMime, pageKey, applyTemplate, hostOf } from './lib/media.js';
import { parseM3U8, variantLabel, audioOptions, subtitleOptions, mediaLabel } from './lib/hls.js';
import { parseMpd, representationLabel, dashAudioOptions } from './lib/dash.js';
import { makePrepare, FETCH_INIT } from './lib/net.js';
import { enqueue, openManager, newJobId, unfinishedJobs, loadSettings } from './lib/jobs.js';

const $ = (s) => document.querySelector(s);
const listEl = $('#list');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const settings = await loadSettings();
const curPage = pageKey(tab?.url || '');
$('#page').textContent = tab?.title || tab?.url || '';

/** A video from another sub-page of this tab (navigation in an SPA without a reload). */
const isEarlier = (item) => !!item.page && item.page !== curPage;
/** Whether the "Earlier on this tab" section is expanded (null = default). */
let earlierOpen = null;
/** Posters, og:image and video durations of the current sub-page (from content.js). */
let pageMeta = null;

/** url -> Promise<analyzed playlist/manifest | {error}> */
const analysis = new Map();
/** url -> user choices { v, a, s, name } (kept between list refreshes) */
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
          const r = await fetchText(item, item.url);
          if (item.kind === 'dash') return { kind: 'dash', ...parseMpd(r.text, r.url) };
          const pl = parseM3U8(r.text, r.url);
          if (pl.kind === 'master' && pl.variants.length) {
            // The duration and whether it's a live stream are known only from a variant playlist.
            try {
              const v = await fetchText(item, pl.variants[0].url);
              const media = parseM3U8(v.text, v.url);
              pl.live = !media.endList;
              pl.duration = media.endList ? media.duration : 0;
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

/** Selection list; options: [[value, label], …]. */
function select(title, options, value, onchange) {
  const s = el('select', { title, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => el('option', { value: v }, l)));
  if (value != null && options.some(([v]) => v === value)) s.value = value;
  return s;
}

/** Estimated size from the bit rate (b/s) and duration (s). */
const estimate = (bandwidth, duration) => (bandwidth && duration ? ` · ~${formatBytes((bandwidth / 8) * duration)}` : '');

/** Default file name from the template in the settings. */
function defaultName(item, quality = '') {
  const earlier = isEarlier(item);
  return applyTemplate(settings.template, {
    title: earlier ? item.title : tab?.title,
    quality,
    file: nameFromUrl(item.url),
    host: hostOf(earlier ? item.page : tab?.url)
  });
}

const videoOf = (item) => (!isEarlier(item) && pageMeta?.videos?.[item.key]) || null;

/** Thumbnail: this video's poster, and for streams (and the only video on the page) – the player's poster or og:image. */
function thumbOf(item, single) {
  if (isEarlier(item) || !pageMeta) return '';
  const own = videoOf(item);
  if (own?.poster) return own.poster;
  if (item.kind === 'file' && !single) return '';
  const videos = Object.values(pageMeta.videos || {});
  return videos.find((v) => v.stream && v.poster)?.poster || videos.find((v) => v.poster)?.poster || pageMeta.og || '';
}

async function startJob(job) {
  await enqueue({ id: newJobId(), createdAt: Date.now(), ...job });
  toast(job.record ? 'Recording started in the manager ⏺' : 'Added to the download manager ⚡');
  updateFooter();
}

/**
 * Skeleton of a list item: thumbnail, editable file name, description, actions, options.
 * name() – the name typed by the user (or the default one).
 */
function card(item, defName, badge, ctx) {
  const s = sel(item.url);
  const input = el('input', {
    class: 'fname',
    type: 'text',
    spellcheck: 'false',
    title: 'File name (without extension) – you can change it before downloading',
    oninput: (e) => (s.name = e.target.value)
  });
  input.value = s.name ?? defName;
  const src = thumbOf(item, ctx.single);
  const thumb = el(
    'div',
    { class: 'thumb' },
    src ? el('img', { src, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null
  );
  const meta = el('div', { class: 'meta' }, badge);
  const actions = el('div', { class: 'actions' });
  const opts = el('div', { class: 'opts' });
  const box = el('div', { class: 'item' }, thumb, input, meta, opts, actions);
  const tail = () => meta.append(el('span', { class: 'src muted ellipsis', title: item.url }, nameFromUrl(item.url) || hostOf(item.url)));
  return { box, meta, actions, opts, tail, name: () => sanitizeFilename(input.value, defName) };
}

/** Subtitle choice: '' = none, 'all' = all of them, or an index. */
function subtitlePicker(item, subs, label) {
  if (!subs.length) return null;
  const options = [['', 'No subtitles'], ...subs.map((s, i) => [String(i), `Subtitles: ${label(s)}`])];
  if (subs.length > 1) options.push(['all', 'All subtitles']);
  return select('Subtitles (saved next to the video as .srt)', options, sel(item.url).s ?? '', (v) => (sel(item.url).s = v));
}
const chosenSubs = (item, subs) => {
  const v = sel(item.url).s ?? '';
  return v === 'all' ? subs : v === '' ? [] : [subs[Number(v)]].filter(Boolean);
};

function renderFile(item, ctx) {
  // Empty = the manager will work out the extension from the response's Content-Type.
  const ext = item.ext || extFromMime(item.mime) || '';
  const video = videoOf(item);
  const c = card(item, defaultName(item, video?.height ? `${video.height}p` : ''), el('span', { class: 'badge' }, (ext || 'video').toUpperCase()), ctx);
  const subs = item.subs || [];
  const turbo = el(
    'button',
    {
      class: 'primary',
      title: 'Download over many connections at once',
      onclick: () =>
        startJob({
          kind: 'file',
          url: item.url,
          headers: item.headers,
          filename: c.name(),
          ext,
          label: nameFromUrl(item.url) || hostOf(item.url),
          subs: chosenSubs(item, subs)
        })
    },
    '⚡ Download'
  );
  const plain = el(
    'button',
    {
      title: 'Regular browser download (1 connection, without the page headers)',
      onclick: async () => {
        try {
          await chrome.downloads.download({ url: item.url, filename: `${c.name()}.${ext || 'mp4'}`, conflictAction: 'uniquify' });
          toast('Handed over to the browser downloads');
        } catch (e) {
          toast('Error: ' + e.message);
        }
      }
    },
    '↓'
  );
  c.actions.append(turbo, plain);
  if (video?.duration) c.meta.append(el('span', {}, formatDuration(video.duration)));
  c.meta.append(el('span', {}, item.size ? formatBytes(item.size) : 'size unknown'));
  c.tail();
  const sp = subtitlePicker(item, subs, (s) => s.label || s.lang || 'subtitles');
  if (sp) c.opts.append(sp);
  return c.box;
}

function renderHls(item, info, ctx) {
  const s = sel(item.url);
  const variant = info?.kind === 'master' ? info.variants[Number(s.v ?? 0)] || info.variants[0] : null;
  const c = card(item, defaultName(item, variant?.height ? `${variant.height}p` : ''), el('span', { class: 'badge hls' }, 'HLS'), ctx);
  const { box, meta, actions, opts } = c;
  if (!info) {
    meta.append(el('span', { class: 'muted' }, 'analyzing the playlist…'));
    actions.append(el('button', { class: 'primary', disabled: '' }, '⚡ Download'));
    return box;
  }
  const btn = el('button', { class: 'primary' }, info.live ? '⏺ Record' : '⚡ Download');
  if (info.live) btn.title = 'Records the live stream until you stop it in the download manager';
  actions.append(btn);
  const base = { kind: 'hls', url: item.url, headers: item.headers, record: !!info.live };
  const label = nameFromUrl(item.url) || 'stream';

  if (info.error) {
    meta.append(el('span', { class: 'muted' }, "couldn't read the playlist – will try anyway"));
    btn.onclick = () => startJob({ ...base, filename: c.name(), label });
    return box;
  }
  if (info.encrypted) {
    btn.disabled = true;
    btn.textContent = '🔒 Encrypted';
    box.append(el('div', { class: 'note' }, 'Protected stream (DRM / encryption) – cannot be downloaded.'));
    return box;
  }
  if (info.live) meta.append(el('span', { class: 'badge live' }, 'LIVE'));

  if (info.kind === 'master') {
    if (!info.variants.length) {
      btn.disabled = true;
      meta.append(el('span', { class: 'muted' }, 'no video variants'));
      return box;
    }
    opts.prepend(
      select('Quality (estimated size)', info.variants.map((v, i) => [String(i), variantLabel(v) + estimate(v.bandwidth, info.duration)]), s.v ?? '0', (v) => {
        s.v = v;
        redraw();
      })
    );
    const audios = audioOptions(info, variant);
    if (audios.length > 1) {
      opts.append(select('Audio track', audios.map((a, i) => [String(i), `Audio: ${mediaLabel(a)}`]), s.a ?? '0', (v) => (s.a = v)));
    }
    const subs = info.live ? [] : subtitleOptions(info, variant);
    const sp = subtitlePicker(item, subs, mediaLabel);
    if (sp) opts.append(sp);
    if (info.duration) meta.append(el('span', {}, formatDuration(info.duration)));
    meta.append(el('span', {}, `${info.variants.length} ${info.variants.length === 1 ? 'quality' : 'qualities'}`));
    c.tail();
    btn.onclick = () => {
      const a = audios[Number(s.a ?? 0)];
      startJob({
        ...base,
        variantUrl: variant.url,
        audioUrl: a?.url,
        subtitles: chosenSubs(item, subs).map(({ url, name, language }) => ({ url, name, language })),
        filename: c.name(),
        label: `${label} · ${variantLabel(variant)}${a && audios.length > 1 ? ` · ${mediaLabel(a)}` : ''}`
      });
    };
    return box;
  }

  // media playlist (list of segments)
  if (!info.live) meta.append(el('span', {}, formatDuration(info.duration)));
  meta.append(el('span', { class: 'muted' }, `${info.segments.length} segments`));
  c.tail();
  btn.onclick = () => startJob({ ...base, filename: c.name(), label });
  return box;
}

function renderDash(item, info, ctx) {
  const s = sel(item.url);
  const videos = info && !info.error ? info.video.filter((r) => !r.encrypted) : [];
  const audios = info && !info.error ? dashAudioOptions(info) : [];
  const video = videos[Number(s.v ?? 0)] || videos[0];
  const c = card(item, defaultName(item, video?.height ? `${video.height}p` : ''), el('span', { class: 'badge dash' }, 'DASH'), ctx);
  const { box, meta, actions, opts } = c;
  const label = nameFromUrl(item.url) || 'manifest';
  if (!info) {
    meta.append(el('span', { class: 'muted' }, 'analyzing the manifest…'));
    actions.append(el('button', { class: 'primary', disabled: '' }, '⚡ Download'));
    return box;
  }
  const btn = el('button', { class: 'primary' }, '⚡ Download');
  actions.append(btn);
  if (info.error) {
    meta.append(el('span', { class: 'muted' }, "couldn't read the manifest – will try anyway"));
    btn.onclick = () => startJob({ kind: 'dash', url: item.url, headers: item.headers, filename: c.name(), label });
    return box;
  }
  if (info.dynamic) {
    btn.disabled = true;
    meta.append(el('span', { class: 'badge live' }, 'LIVE'));
    box.append(el('div', { class: 'note' }, 'Live streams in DASH format are not supported (HLS ones are).'));
    return box;
  }
  if (!videos.length && !audios.length) {
    btn.disabled = true;
    btn.textContent = info.encrypted ? '🔒 Encrypted' : 'No tracks';
    if (info.encrypted) box.append(el('div', { class: 'note' }, 'Protected stream (DRM) – cannot be downloaded.'));
    return box;
  }
  const audioBw = (audios[Number(s.a ?? 0)] || audios[0])?.bandwidth || 0;
  if (videos.length) {
    opts.prepend(
      select('Quality (estimated size)', videos.map((r, i) => [String(i), representationLabel(r) + estimate(r.bandwidth + audioBw, info.duration)]), s.v ?? '0', (v) => {
        s.v = v;
        redraw();
      })
    );
  }
  if (audios.length > 1) {
    opts.append(select('Audio track', audios.map((r, i) => [String(i), `Audio: ${mediaLabel({ name: r.label, language: r.lang })}`]), s.a ?? '0', (v) => (s.a = v)));
  }
  const texts = info.text.filter((r) => r.container === 'vtt' && r.single);
  const sp = subtitlePicker(item, texts, (r) => mediaLabel({ name: r.label, language: r.lang }));
  if (sp) opts.append(sp);
  if (info.duration) meta.append(el('span', {}, formatDuration(info.duration)));
  if (videos.length > 1) meta.append(el('span', {}, `${videos.length} qualities`));
  if (info.multiPeriod) meta.append(el('span', { class: 'muted' }, 'first part only'));
  c.tail();
  btn.onclick = () => {
    const a = audios[Number(s.a ?? 0)];
    startJob({
      kind: 'dash',
      url: item.url,
      headers: item.headers,
      videoId: video?.id,
      audioId: a?.id,
      textIds: chosenSubs(item, texts).map((r) => r.id),
      filename: c.name(),
      label: `${label} · ${video ? representationLabel(video) : 'audio'}`
    });
  };
  return box;
}

let renderSeq = 0;
let drawPending = false;
async function render() {
  const seq = ++renderSeq;
  const { items = [], info = null } = (await chrome.runtime.sendMessage({ type: 'get-media', tabId: tab.id })) || {};
  pageMeta = info && info.page === curPage ? info : null;

  // Analysis of playlists/manifests: qualities, audio, subtitles, and for HLS – hiding the master's variants.
  const infos = new Map();
  const pending = items.filter((i) => i.kind === 'hls' || i.kind === 'dash').map(async (i) => infos.set(i.url, await analyze(i)));

  const draw = () => {
    if (seq !== renderSeq) return;
    // Don't interrupt typing the name – refresh after leaving the field.
    if (document.activeElement?.classList?.contains('fname')) {
      drawPending = true;
      return;
    }
    const children = new Set();
    for (const a of infos.values()) {
      if (a?.kind === 'master') {
        a.variants.forEach((v) => children.add(v.url));
        a.audios.forEach((x) => x.url && children.add(x.url));
        (a.subtitles || []).forEach((x) => children.add(x.url));
      }
    }
    const visible = items
      .filter((i) => !i.hidden) // parts of a master playlist already recognized in the background
      .filter((i) => !(i.kind === 'hls' && children.has(i.url)))
      .filter((i) => !(i.kind === 'hls' && infos.get(i.url)?.kind === 'media' && !infos.get(i.url).segments.length))
      .sort((a, b) => {
        const rank = (x) => (x.kind === 'hls' ? (infos.get(x.url)?.kind === 'master' ? 0 : 1) : x.kind === 'dash' ? 0 : 2);
        return rank(a) - rank(b) || (b.size || 0) - (a.size || 0);
      });

    const current = visible.filter((i) => !isEarlier(i));
    const earlier = visible.filter(isEarlier);
    const ctx = { single: current.length === 1 };
    const renderItem = (i) =>
      i.kind === 'file' ? renderFile(i, ctx) : i.kind === 'hls' ? renderHls(i, infos.get(i.url), ctx) : renderDash(i, infos.get(i.url), ctx);

    listEl.replaceChildren();
    if (!current.length) {
      listEl.append(
        el(
          'div',
          { class: 'empty' },
          el('b', {}, earlier.length ? 'No videos detected on this sub-page yet.' : 'No videos detected on this tab yet.'),
          el('br'),
          'Start playing the video – the extension will pick it up from the network traffic. ',
          earlier.length ? null : 'If the page was open before the extension was installed, reload it.'
        )
      );
    }
    listEl.append(...current.map(renderItem));
    if (earlier.length) {
      const box = el(
        'details',
        { class: 'earlier', ontoggle: (e) => (earlierOpen = e.target.open) },
        el('summary', {}, `Earlier on this tab (${earlier.length})`),
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

listEl.addEventListener('focusout', (e) => {
  if (e.target.classList?.contains('fname') && drawPending) {
    drawPending = false;
    setTimeout(() => redraw());
  }
});

/** Count of unfinished downloads (interrupted by closing the manager or a restart). */
async function updateFooter() {
  const open = (await unfinishedJobs()).filter((j) => j.status !== 'done').length;
  $('#open-manager').textContent = open ? `Download manager (${open})` : 'Download manager';
  $('#open-manager').title = open ? `${open} unfinished downloads – open the manager to resume them` : '';
}

$('#open-manager').onclick = () => openManager(true);
$('#clear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clear-media', tabId: tab.id });
  analysis.clear();
  render();
};

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes['tab:' + tab.id] || changes['info:' + tab.id]) render();
});

render();
updateFooter();
