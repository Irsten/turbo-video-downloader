// YouTube downloads – personal build only: the store package (scripts/package.mjs) ships
// scripts/store/external.js in place of this module, so none of it is published.
//
// The extension doesn't fetch YouTube's streams itself. A helper program on this computer –
// native/host.mjs, registered with `node native/install.mjs <extension id>` – runs yt-dlp and saves the
// finished file straight into the downloads folder; the extension talks to it with native messaging.
import { tr } from './i18n.js';
import { loadSettings, openManager } from './jobs.js';
import { applyTemplate, formatBytes, formatDuration, sanitizeFilename } from './media.js';

export const EXTERNAL_ENABLED = true;
const HOST_NAME = 'com.turbovd.ytdlp';
const INFO_TTL = 30 * 60 * 1000; // video descriptions are kept in the session for 30 minutes
const INFO_PREFIX = 'yt:';

// ---------------------------------------------------------------- YouTube addresses
const YT_HOSTS = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;

/** The 11-character video ID of a YouTube video page (watch, youtu.be, shorts, live, embed) or null. */
export function youtubeVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  let id = null;
  if (/^(?:www\.)?youtu\.be$/i.test(u.hostname)) id = u.pathname.split('/')[1];
  else if (YT_HOSTS.test(u.hostname)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/(?:shorts|live|embed|v)\/([^/]+)/.exec(u.pathname)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

/** Badge on the icon: a YouTube video page counts as one video. */
export const pageVideoCount = (url) => (youtubeVideoId(url) ? 1 : 0);

// ---------------------------------------------------------------- talking to the helper
/** The helper's name; the tests register their own (hidden setting `nativeHost`). */
async function hostName() {
  return (await loadSettings()).nativeHost || HOST_NAME;
}

const MESSAGES = { NO_HOST: 'ytErrNoHost', FORBIDDEN: 'ytErrForbidden', NO_YTDLP: 'ytErrNoYtdlp', YTDLP: 'ytErrYtdlp', HOST_EXITED: 'ytErrHostExited' };
const SETUP_ERRORS = new Set(['NO_HOST', 'FORBIDDEN', 'NO_YTDLP']);

function hostError(code, detail = '') {
  const key = MESSAGES[code];
  return Object.assign(new Error(key ? tr(key, detail) : detail || tr('ytErrHostExited', code || '?')), { code });
}

/** Chrome's errors when the helper is missing, not allowed or crashed. */
function connectError(e) {
  const m = e?.message || String(e || '');
  if (/not found/i.test(m)) return hostError('NO_HOST');
  if (/forbidden/i.test(m)) return hostError('FORBIDDEN');
  return hostError('HOST_EXITED', m || '?');
}

async function call(msg) {
  let r;
  try {
    r = await chrome.runtime.sendNativeMessage(await hostName(), msg);
  } catch (e) {
    throw connectError(e);
  }
  if (!r?.ok) throw hostError(r?.code, r?.error);
  return r;
}

/** {ytdlp: version | null, ffmpeg, outDir, error} */
export const probeHost = () => call({ cmd: 'probe' });
/** Shows a file saved by the helper in Explorer / Finder. */
export const revealFile = (path) => call({ cmd: 'reveal', path }).catch((e) => console.warn('Could not show the file', e));
/** Removes the partial files of a removed download. */
export const cleanupExternal = (id) => call({ cmd: 'cleanup', id }).catch(() => {});

async function videoInfo(id, fresh = false) {
  const key = INFO_PREFIX + id;
  if (!fresh) {
    const { [key]: cached } = await chrome.storage.session.get(key).catch(() => ({}));
    if (cached && Date.now() - cached.at < INFO_TTL) return cached.info;
  }
  const { info } = await call({ cmd: 'info', url: watchUrl(id) });
  chrome.storage.session.set({ [key]: { at: Date.now(), info } }).catch(() => {});
  return info;
}

async function clearInfoCache() {
  const all = await chrome.storage.session.get(null).catch(() => ({}));
  const keys = Object.keys(all).filter((k) => k.startsWith(INFO_PREFIX));
  if (keys.length) await chrome.storage.session.remove(keys).catch(() => {});
}

/**
 * Downloads a job of kind 'external' over a connectNative port. Resolves with {files: [{path, name, size}], separate}.
 * Aborting (pause) asks the helper to stop yt-dlp; its partial files stay, and the next run continues them.
 */
export async function downloadExternal(job, { signal, onProgress, onPhase } = {}) {
  const name = await hostName();
  signal?.throwIfAborted(); // paused before the helper was started
  const port = chrome.runtime.connectNative(name);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const aborted = () => signal?.reason ?? new DOMException('Aborted', 'AbortError');
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        // already disconnected
      }
      fn(value);
    };
    // The helper confirms once yt-dlp is stopped; closing the port right away would leave that to chance.
    const onAbort = () => {
      try {
        port.postMessage({ cmd: 'cancel' });
      } catch {
        return settle(reject, aborted());
      }
      timer = setTimeout(() => settle(reject, aborted()), 4000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    port.onMessage.addListener((m) => {
      if (m.type === 'progress') onProgress?.(m);
      else if (m.type === 'phase') onPhase?.(m);
      else if (m.type === 'done') settle(resolve, m);
      else if (m.type === 'canceled') settle(reject, aborted());
      else if (m.type === 'error' || m.ok === false) settle(reject, hostError(m.code, m.error));
    });
    port.onDisconnect.addListener(() => settle(reject, signal?.aborted ? aborted() : connectError(chrome.runtime.lastError)));
    port.postMessage({
      cmd: 'download',
      id: job.id,
      url: job.url,
      video: job.video || null,
      audio: job.audio || null,
      subs: job.subs || [],
      filename: job.filename,
      size: job.size || 0
    });
  });
}

// ---------------------------------------------------------------- popup card
const cleanTitle = (t) =>
  String(t || '')
    .replace(/^\(\d+\)\s*/, '') // "(3) " – unread notifications
    .replace(/\s+-\s+YouTube$/i, '')
    .trim();

/**
 * Card of the YouTube video open in the tab (or null). ctx: { tab, settings, el, startJob } from the popup.
 * Qualities, audio only and subtitles come from yt-dlp (through the helper).
 */
export function externalCard({ tab, settings, el, startJob }) {
  const id = youtubeVideoId(tab?.url || '');
  if (!id) return null;
  const st = { info: null, error: null, loading: true, choice: null, subs: '', typed: false };
  const input = el('input', { class: 'fname', type: 'text', spellcheck: 'false', title: tr('fileNameTitle'), oninput: () => (st.typed = true) });
  const thumb = el(
    'div',
    { class: 'thumb' },
    el('img', { src: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() })
  );
  const meta = el('div', { class: 'meta' });
  const opts = el('div', { class: 'opts' });
  const actions = el('div', { class: 'actions' });
  const note = el('div', { class: 'note' });
  const box = el('div', { class: 'item external' }, thumb, input, meta, opts, actions, note);

  const options = () => {
    const i = st.info;
    const list = i.qualities.map((q) => ({ ...q, key: q.video }));
    if (i.audio) list.push({ ...i.audio, key: 'audio', video: null, label: tr('ytAudioOnly', i.audio.ext.toUpperCase()) });
    return list;
  };
  // Default: the best quality up to 1080p (larger files only when chosen).
  const chosen = (list) =>
    list.find((o) => o.key === st.choice && !o.needsFfmpeg) ||
    list.find((o) => o.video && !o.needsFfmpeg && o.height <= 1080) ||
    list.find((o) => !o.needsFfmpeg);
  const nameFor = (o) =>
    applyTemplate(settings.template, { title: st.info?.title || cleanTitle(tab.title), quality: o?.video ? o.label : '', file: id, host: 'youtube.com' });
  const link = (text, onclick) =>
    el('a', {
      href: '#',
      onclick: (e) => {
        e.preventDefault();
        onclick();
      }
    }, text);

  const draw = () => {
    const list = st.info && !st.info.live ? options() : [];
    const cur = chosen(list);
    if (!st.typed) input.value = nameFor(cur);
    meta.replaceChildren(el('span', { class: 'badge', style: 'background:#5a1f27;color:#ffc2c7' }, 'YouTube'));
    opts.replaceChildren();
    note.replaceChildren();
    note.hidden = true;
    const say = (...parts) => {
      note.hidden = false;
      note.append(...parts);
    };
    const btn = el('button', { class: 'primary', disabled: '' }, tr('download'));
    actions.replaceChildren(btn);

    if (st.loading) return meta.append(el('span', { class: 'muted' }, tr('ytAsking')));
    if (st.error) {
      if (SETUP_ERRORS.has(st.error.code)) say(st.error.message + ' ', link(tr('ytSetupLink'), () => openManager(true)));
      else say(st.error.message + ' ', link(tr('ytTryAgain'), () => load(true)));
      return;
    }
    const i = st.info;
    if (i.duration) meta.append(el('span', {}, formatDuration(i.duration)));
    if (i.channel) meta.append(el('span', { class: 'src muted ellipsis', title: i.channel }, i.channel));
    if (i.live) {
      meta.append(el('span', { class: 'badge live' }, tr('live')));
      return say(tr('ytLiveUnsupported'));
    }
    if (!cur) return say(tr('ytNoFormats'));

    const quality = el(
      'select',
      {
        title: tr('qualityTitle'),
        onchange: (e) => {
          st.choice = e.target.value;
          draw();
        }
      },
      list.map((o) =>
        el(
          'option',
          { value: o.key, disabled: o.needsFfmpeg ? '' : null },
          [o.video ? `${o.label} · ${o.codec}` : o.label, o.size ? `~${formatBytes(o.size)}` : null, o.needsFfmpeg ? tr('ytNeedsFfmpeg') : null]
            .filter(Boolean)
            .join(' · ')
        )
      )
    );
    quality.value = cur.key;
    opts.append(quality);

    const subs = i.subtitles || [];
    if (subs.length) {
      const choices = [['', tr('subtitlesNone')], ...subs.map((s, n) => [String(n), tr('subtitlesItem', s.name || s.lang)])];
      if (subs.length > 1) choices.push(['all', tr('subtitlesAll')]);
      const sp = el('select', { title: tr('subtitlesTitle'), onchange: (e) => (st.subs = e.target.value) }, choices.map(([v, l]) => el('option', { value: v }, l)));
      sp.value = st.subs;
      opts.append(sp);
    }
    if (!i.ffmpeg && list.some((o) => o.needsFfmpeg)) say(tr('ytFfmpegHint'));

    btn.disabled = false;
    btn.onclick = () => {
      const langs = st.subs === 'all' ? subs : st.subs === '' ? [] : [subs[Number(st.subs)]].filter(Boolean);
      startJob({
        kind: 'external',
        source: 'youtube',
        url: watchUrl(id),
        headers: {},
        video: cur.video || null,
        audio: cur.audio || null,
        subs: langs.map((s) => s.lang),
        size: cur.size || 0,
        filename: sanitizeFilename(input.value, nameFor(cur)),
        label: `${i.title || id} · ${cur.video ? cur.label : tr('ytAudio')}`
      });
    };
  };

  const load = async (fresh = false) => {
    Object.assign(st, { loading: true, error: null });
    draw();
    try {
      st.info = await videoInfo(id, fresh);
    } catch (e) {
      st.error = e;
    }
    st.loading = false;
    draw();
  };
  load();
  return box;
}

// ---------------------------------------------------------------- manager: setup / status panel
const INSTALL_TOOLS = {
  win: 'winget install yt-dlp.yt-dlp Gyan.FFmpeg',
  mac: 'brew install yt-dlp ffmpeg',
  linux: 'pipx install yt-dlp   # ffmpeg: from your distribution, e.g. sudo apt install ffmpeg'
};

/** The "YouTube (yt-dlp)" panel of the manager: whether the helper and yt-dlp work, and how to set them up. */
export function mountExternalSetup(container) {
  const box = document.createElement('details');
  box.className = 'panel helper';
  box.id = 'youtube';
  const summary = document.createElement('summary');
  const body = document.createElement('div');
  box.append(summary, body);
  container.append(box);
  let first = true;

  const check = async () => {
    summary.textContent = `${tr('ytSetupTitle')} – ${tr('ytSetupChecking')}`;
    let r = null;
    let err = null;
    try {
      r = await probeHost();
    } catch (e) {
      err = e;
    }
    const ready = !!r?.ytdlp;
    summary.textContent = `${tr('ytSetupTitle')} – ${tr(ready ? 'ytSetupReady' : 'ytSetupNotReady')}`;
    const os = (await chrome.runtime.getPlatformInfo().catch(() => null))?.os;
    const p = (text, cls) => {
      const e = document.createElement('p');
      if (cls) e.className = cls;
      e.textContent = text;
      return e;
    };
    const code = (text) => {
      const c = document.createElement('code');
      c.textContent = text;
      return c;
    };
    const parts = [p(tr('ytSetupIntro'))];
    if (ready) {
      parts.push(p(tr('ytStatusYtdlp', r.ytdlp), 'ok'), p(tr(r.ffmpeg ? 'ytStatusFfmpeg' : 'ytStatusNoFfmpeg')), p(tr('ytStatusFolder', r.outDir)));
    } else {
      parts.push(p(err ? err.message : tr('ytErrNoYtdlp'), 'warn'));
      parts.push(p(tr('ytStepTools')), code(INSTALL_TOOLS[os] || INSTALL_TOOLS.win));
      if (r) parts.push(p(tr('ytConfigHint')));
      else parts.push(p(tr('ytStepInstall')), code(`node native/install.mjs ${chrome.runtime.id}`));
      parts.push(p(tr('ytStepCheck')));
    }
    const again = document.createElement('button');
    again.textContent = tr('ytCheckAgain');
    again.addEventListener('click', check);
    parts.push(again);
    body.replaceChildren(...parts);
    if (first) box.open = !ready || location.hash === '#youtube';
    first = false;
    // The popup keeps video descriptions for a while – after a change (e.g. ffmpeg installed) they are fetched again.
    clearInfoCache();
  };
  check();
}
