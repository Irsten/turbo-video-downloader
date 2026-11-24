// yt-dlp helpers of the native host (native/host.mjs): turning yt-dlp's JSON into the short
// description the popup shows, building the command line of a download and reading its progress.
// Pure functions – tested without yt-dlp in tests/youtube.test.mjs.

const isVideo = (f) => !!f.vcodec && f.vcodec !== 'none';
const isAudio = (f) => !!f.acodec && f.acodec !== 'none';
/** Plain HTTP(S) formats (YouTube's DASH files). HLS, storyboards and the like are skipped. */
const isDirect = (f) => /^https?$/.test(f.protocol || 'https') && f.ext !== 'mhtml';

/** Size in bytes: exact, approximate or worked out from the bit rate. */
export function sizeOf(f, duration = 0) {
  return Math.round(f?.filesize || f?.filesize_approx || (f?.tbr && duration ? f.tbr * 125 * duration : 0)) || 0;
}

export function codecName(vcodec = '') {
  const c = vcodec.toLowerCase();
  if (/^(avc|h264)/.test(c)) return 'H.264';
  if (/^(hev|hvc|h265)/.test(c)) return 'H.265';
  if (/^av01/.test(c)) return 'AV1';
  if (/^vp0?9/.test(c)) return 'VP9';
  if (/^vp0?8/.test(c)) return 'VP8';
  return c.split('.')[0].toUpperCase();
}

/** Best audio: the original language first, without dynamic range compression, the highest bit rate. */
function bestAudio(list) {
  const drc = (f) => /drc/i.test(`${f.format_id} ${f.format_note || ''}`);
  return [...list].sort(
    (a, b) =>
      (b.language_preference ?? 0) - (a.language_preference ?? 0) || drc(a) - drc(b) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)
  )[0];
}

/**
 * Short description of a video for the popup.
 * Without ffmpeg only MP4 video + M4A audio can be merged (by the extension's own remuxer),
 * so qualities available only as WebM are marked `needsFfmpeg`.
 */
export function compactInfo(j, { ffmpeg = false } = {}) {
  const duration = j.duration || 0;
  const formats = (j.formats || []).filter((f) => f.format_id && !f.has_drm && isDirect(f));
  const audios = formats.filter((f) => isAudio(f) && !isVideo(f));
  const m4a = bestAudio(audios.filter((f) => f.ext === 'm4a'));
  const anyAudio = m4a || bestAudio(audios);

  // Video-only formats (merged with audio); without them – formats that have both.
  let videos = formats.filter((f) => isVideo(f) && !isAudio(f) && f.height);
  const progressive = !videos.length;
  if (progressive) videos = formats.filter((f) => isVideo(f) && f.height);

  const byHeight = new Map();
  for (const f of videos) {
    if (!byHeight.has(f.height)) byHeight.set(f.height, []);
    byHeight.get(f.height).push(f);
  }
  const qualities = [...byHeight]
    .sort((a, b) => b[0] - a[0])
    .map(([height, list]) => {
      // MP4 first (plays everywhere and can be merged without ffmpeg), then frame rate and bit rate.
      list.sort((a, b) => (b.ext === 'mp4') - (a.ext === 'mp4') || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0));
      const v = list[0];
      const a = progressive ? null : anyAudio;
      const fps = Math.round(v.fps || 0);
      return {
        label: `${height}p${fps > 30 ? fps : ''}`,
        height,
        fps,
        codec: codecName(v.vcodec),
        video: v.format_id,
        audio: a?.format_id || null,
        ext: 'mp4',
        size: sizeOf(v, duration) + sizeOf(a, duration),
        needsFfmpeg: !ffmpeg && (v.ext !== 'mp4' || (!!a && a.ext !== 'm4a'))
      };
    });

  const subtitles = Object.entries(j.subtitles || {})
    .filter(([lang, list]) => lang !== 'live_chat' && Array.isArray(list) && list.some((s) => s.ext === 'vtt'))
    .map(([lang, list]) => ({ lang, name: list.find((s) => s.name)?.name || lang }));

  return {
    id: j.id || '',
    title: j.title || '',
    channel: j.channel || j.uploader || '',
    duration,
    thumbnail: j.thumbnail || '',
    live: !!j.is_live || j.live_status === 'is_live' || j.live_status === 'is_upcoming',
    ffmpeg: !!ffmpeg,
    qualities,
    audio: anyAudio ? { audio: anyAudio.format_id, ext: anyAudio.ext === 'webm' ? 'webm' : 'm4a', size: sizeOf(anyAudio, duration) } : null,
    subtitles
  };
}

const FORMAT_ID = /^[\w-]{1,40}$/;
const LANG = /^[\w-]{1,20}$/;
export const PROGRESS_TEMPLATE =
  'download:TVD %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(info.format_id)s';

/** Checks a download request from the extension – everything ends up on yt-dlp's command line. */
export function checkRequest(msg) {
  if (!/^https?:\/\/\S+$/i.test(msg?.url || '')) throw Object.assign(new Error('Not a web address'), { code: 'BAD_REQUEST' });
  if (!/^[\w-]{1,64}$/.test(msg.id || '')) throw Object.assign(new Error('Bad job id'), { code: 'BAD_REQUEST' });
  for (const f of [msg.video, msg.audio]) if (f != null && !FORMAT_ID.test(f)) throw Object.assign(new Error('Bad format'), { code: 'BAD_REQUEST' });
  if (!msg.video && !msg.audio) throw Object.assign(new Error('No format chosen'), { code: 'BAD_REQUEST' });
  for (const l of msg.subs || []) if (!LANG.test(l)) throw Object.assign(new Error('Bad subtitle language'), { code: 'BAD_REQUEST' });
}

/**
 * yt-dlp arguments of a download into the working folder `work`:
 * - with ffmpeg video and audio are merged by yt-dlp into v.mp4,
 * - without it they land in f<format>.<ext> and the host merges them itself.
 * Subtitles: v.<language>.vtt.
 */
export function downloadArgs(msg, { ffmpeg = false, ffmpegPath = '', work, extra = [] }) {
  const both = msg.video && msg.audio;
  const merge = !!both && !!ffmpeg;
  const args = ['--newline', '--no-playlist', '--no-mtime', '--progress-template', PROGRESS_TEMPLATE, '-P', work];
  if (merge) args.push('-f', `${msg.video}+${msg.audio}`, '--merge-output-format', 'mp4', '-o', 'v.%(ext)s');
  else args.push('-f', [msg.video, msg.audio].filter(Boolean).join(','), '--fixup', 'never', '-o', 'f%(format_id)s.%(ext)s');
  if (msg.subs?.length) args.push('--write-subs', '--sub-langs', msg.subs.join(','), '--sub-format', 'vtt', '-o', 'subtitle:v.%(ext)s');
  if (ffmpeg && ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
  args.push(...extra, '--', msg.url);
  return { args, merge };
}

const num = (s) => (s == null || s === 'NA' || s === 'None' || s === '' ? null : Number(s));

/** A progress line printed with PROGRESS_TEMPLATE, or null. */
export function parseProgress(line) {
  const m = /^TVD (\S+) (\S+) (\S+) (\S+) (\S+)/.exec(line.trim());
  if (!m) return null;
  const downloaded = num(m[1]);
  if (downloaded == null || Number.isNaN(downloaded)) return null;
  return { downloaded, total: num(m[2]) ?? num(m[3]), speed: num(m[4]), format: m[5] };
}

/** The message of yt-dlp's last "ERROR:" line, without the "[youtube] <id>:" prefix. */
export function errorMessage(stderr, code) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = lines.filter((l) => l.startsWith('ERROR:')).pop();
  if (err) return err.replace(/^ERROR:\s*/, '').replace(/^\[[\w:]+\]\s*[\w-]+:\s*/, '');
  return lines.pop() || `yt-dlp exited with code ${code}`;
}

/** Safe file name on every system (the extension sanitizes it too – this is the second line of defence). */
export function safeName(name) {
  const s = String(name || '')
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  const chars = Array.from(s);
  const cut = chars.length > 120 ? chars.slice(0, 120).join('').trim() : s;
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cut) || !cut ? 'video' : cut;
}
