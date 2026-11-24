// Native messaging host of Turbo Video Downloader (personal build): downloads YouTube videos with yt-dlp.
// The browser starts it (registered by install.mjs) and talks to it over stdin/stdout: every message
// is a 4-byte little-endian length followed by UTF-8 JSON. Nothing else may be written to stdout.
//
// Requests (one-off with chrome.runtime.sendNativeMessage, a download over a connectNative port):
//   {cmd:'probe'}                 -> {ok, protocol, ytdlp, ffmpeg, outDir, error}
//   {cmd:'info', url}             -> {ok, info}                 (see compactInfo in ytdlp.mjs)
//   {cmd:'download', id, url, video, audio, subs, filename, size}
//                                 -> {type:'phase'|'progress'}…, then {type:'done', files, separate} or {type:'error'}
//   {cmd:'cancel'}                -> stops the download ({type:'canceled'}); its partial files stay for resuming
//   {cmd:'cleanup', id}           -> removes a job's partial files
//   {cmd:'reveal', path}          -> shows a file in the system file manager
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from './config.mjs';
import { compactInfo, checkRequest, downloadArgs, parseProgress, errorMessage, safeName } from './ytdlp.mjs';
import { remuxToMp4, UnsupportedError } from '../lib/remux.js';
import { MemoryFile } from '../lib/store.js';
import { parseVtt, toSrt } from '../lib/subs.js';

const PROTOCOL = 1;
const WORK_DIR = '.turbo-video-downloader'; // partial downloads, inside the output folder (finished files are only renamed)
const coded = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- log (stdout belongs to the browser)
const LOG = process.env.TVD_LOG || path.join(os.tmpdir(), 'turbo-video-downloader-host.log');
function log(...parts) {
  try {
    if (fs.statSync(LOG).size > 1 << 20) fs.truncateSync(LOG, 0);
  } catch {
    // no log yet
  }
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${parts.join(' ')}\n`);
  } catch {
    // logging is best effort
  }
}
console.log = console.info = console.warn = (...a) => log(...a);

// ---------------------------------------------------------------- messages
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// ---------------------------------------------------------------- child processes
const children = new Set();

/** Runs a program; .js/.mjs files are run with this Node. Rejects with code NOT_FOUND, CANCELED or FAILED. */
function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const js = /\.[cm]?js$/i.test(cmd);
    let child;
    try {
      child = spawn(js ? process.execPath : cmd, js ? [cmd, ...args] : args, {
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group – the whole tree can be stopped
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      });
    } catch (e) {
      return reject(coded('NOT_FOUND', `${cmd}: ${e.message}`));
    }
    children.add(child);
    let stdout = '';
    let stderr = '';
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (!onLine) return void (stdout += d);
      const lines = (rest + d).split(/\r?\n|\r/);
      rest = lines.pop();
      for (const l of lines) onLine(l);
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-65536)));
    child.on('error', (e) => {
      children.delete(child);
      reject(e.code === 'ENOENT' ? coded('NOT_FOUND', `${cmd} not found`) : e);
    });
    child.on('close', (code) => {
      children.delete(child);
      if (rest && onLine) onLine(rest);
      if (child.stopped) return reject(coded('CANCELED', 'Canceled'));
      if (code === 0) return resolve({ stdout, stderr });
      log(`${path.basename(cmd)} exited with ${code}:`, stderr.slice(-2000));
      reject(coded('FAILED', errorMessage(stderr, code)));
    });
  });
}

/** Stops a program together with the processes it started (yt-dlp runs ffmpeg). */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stopped = true;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}
const killAll = () => [...children].forEach(killTree);

/** yt-dlp with its errors under the codes the extension knows. */
async function ytdlp(cfg, args, opts) {
  try {
    return await run(cfg.ytdlp, args, opts);
  } catch (e) {
    if (e.code === 'NOT_FOUND') throw coded('NO_YTDLP', e.message);
    if (e.code === 'FAILED') throw coded('YTDLP', e.message);
    throw e;
  }
}

let ffmpegCheck = null;
function hasFfmpeg(cfg) {
  if (!cfg.ffmpeg) return Promise.resolve(false);
  ffmpegCheck ??= run(cfg.ffmpeg, ['-version']).then(
    () => true,
    () => false
  );
  return ffmpegCheck;
}

// ---------------------------------------------------------------- commands
async function probe() {
  const cfg = loadConfig();
  let version = null;
  let error = null;
  try {
    version = (await ytdlp(cfg, ['--version'])).stdout.trim().split(/\r?\n/)[0] || '?';
  } catch (e) {
    error = e.code === 'NO_YTDLP' ? 'NO_YTDLP' : e.message;
  }
  return { protocol: PROTOCOL, ytdlp: version, ffmpeg: await hasFfmpeg(cfg), outDir: cfg.outDir, node: process.version, error };
}

async function info(url) {
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw coded('BAD_REQUEST', 'Not a web address');
  const cfg = loadConfig();
  const { stdout } = await ytdlp(cfg, ['-J', '--no-playlist', '--no-warnings', ...cfg.extra, '--', url]);
  return compactInfo(JSON.parse(stdout), { ffmpeg: await hasFfmpeg(cfg) });
}

const workDir = (cfg, id) => path.join(cfg.outDir, WORK_DIR, id);

async function removeWork(cfg, id) {
  await fsp.rm(workDir(cfg, id), { recursive: true, force: true });
  await fsp.rmdir(path.join(cfg.outDir, WORK_DIR)).catch(() => {}); // only when empty
}

/** The running download (one per connection). */
let current = null;

async function download(msg) {
  checkRequest(msg);
  if (current) throw coded('BUSY', 'A download is already running on this connection');
  const cfg = loadConfig();
  const ctrl = new AbortController();
  current = { ctrl };
  try {
    const ffmpeg = await hasFfmpeg(cfg);
    const work = workDir(cfg, msg.id);
    await fsp.mkdir(work, { recursive: true });
    const { args, merge } = downloadArgs(msg, { ffmpeg, ffmpegPath: /[\\/]/.test(cfg.ffmpeg) ? cfg.ffmpeg : '', work, extra: cfg.extra });
    log('download', msg.url, args.join(' '));

    // Progress of every format (video and audio are downloaded one after another).
    const per = new Map();
    const expected = [msg.video, msg.audio].filter(Boolean);
    let speed = 0;
    let sentAt = 0;
    const report = (force = false) => {
      if (!force && Date.now() - sentAt < 250) return;
      sentAt = Date.now();
      let loaded = 0;
      let total = 0;
      for (const p of per.values()) {
        loaded += p.downloaded;
        total += p.total || 0;
      }
      // Until every format has reported its size, the popup's estimate is the better total.
      if (!expected.every((f) => per.get(f)?.total)) total = Math.max(total, msg.size || 0);
      send({ type: 'progress', loaded, total: total || null, speed });
    };
    send({ type: 'phase', phase: 'download' });
    await ytdlp(cfg, args, {
      onLine: (line) => {
        const p = parseProgress(line);
        if (p) {
          per.set(p.format, { downloaded: p.downloaded, total: p.total });
          speed = p.speed || 0;
          report();
        } else if (/^\[Merger\]/.test(line)) send({ type: 'phase', phase: 'merge' });
      }
    });
    ctrl.signal.throwIfAborted();
    // Formats downloaded in an earlier run print no progress – the final count comes from the files.
    let bytes = 0;
    for (const n of await fsp.readdir(work)) if (!/\.(part|ytdl|vtt)$/i.test(n)) bytes += (await fsp.stat(path.join(work, n))).size;
    send({ type: 'progress', loaded: bytes, total: bytes, speed: 0 });
    const result = await finish(cfg, msg, work, merge, ctrl.signal);
    await removeWork(cfg, msg.id);
    send({ type: 'done', ...result });
  } finally {
    current = null;
  }
}

/** Downloaded files -> the finished file(s) in the output folder. */
async function finish(cfg, msg, work, merge, signal) {
  const names = await fsp.readdir(work);
  const media = names.filter((n) => !/\.(part|ytdl|vtt|srt|temp)$/i.test(n) && !/\.part-Frag\d+/i.test(n));
  const full = (n) => path.join(work, n);
  const outputs = []; // { src, suffix, ext }
  let separate = false;

  if (merge) {
    const v = media.find((n) => /^v\.[^.]+$/.test(n));
    if (!v) throw coded('YTDLP', 'yt-dlp did not produce the merged file');
    outputs.push({ src: full(v), suffix: '', ext: path.extname(v).slice(1) });
  } else {
    const pick = (fid) => fid && media.find((n) => n.startsWith(`f${fid}.`));
    const video = pick(msg.video);
    const audio = pick(msg.audio);
    if ((msg.video && !video) || (msg.audio && !audio)) throw coded('YTDLP', 'yt-dlp did not produce the downloaded file');
    const inputs = [video, audio].filter(Boolean).map(full);
    // YouTube's DASH files are fragmented MP4: merged (or, for audio alone, rewritten) into a regular file.
    const needsRemux = msg.audio && (!msg.video || inputs.length > 1);
    if (needsRemux) {
      const ext = msg.video ? 'mp4' : 'm4a';
      const out = full(`v.${ext}`);
      send({ type: 'phase', phase: 'remux' });
      try {
        await remuxFiles(inputs, out, signal, (f) => send({ type: 'phase', phase: 'remux', fraction: f }));
        outputs.push({ src: out, suffix: '', ext });
      } catch (e) {
        if (signal.aborted) throw coded('CANCELED', 'Canceled');
        if (!(e instanceof UnsupportedError)) log('remux failed', e.stack || e);
        await fsp.rm(out, { force: true });
        inputs.forEach((src, i) => outputs.push({ src, suffix: i && inputs.length > 1 ? ' (audio)' : '', ext: path.extname(src).slice(1) }));
        separate = inputs.length > 1;
      }
    } else outputs.push({ src: inputs[0], suffix: '', ext: path.extname(inputs[0]).slice(1) });
  }
  signal.throwIfAborted();

  const subs = names
    .map((n) => /^v\.(.+)\.vtt$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ src: full(m[0]), lang: m[1] }));

  // One free name for the video and everything that goes with it: "name (1).mp4", "name (1).en.srt".
  await fsp.mkdir(cfg.outDir, { recursive: true });
  const base = safeName(msg.filename);
  const targets = (stem) => [...outputs.map((o) => `${stem}${o.suffix}.${o.ext}`), ...subs.map((s) => `${stem}.${s.lang}.srt`)];
  let stem = base;
  for (let n = 1; targets(stem).some((t) => fs.existsSync(path.join(cfg.outDir, t))); n++) stem = `${base} (${n})`;

  const files = [];
  for (const o of outputs) {
    const dest = path.join(cfg.outDir, `${stem}${o.suffix}.${o.ext}`);
    await move(o.src, dest);
    files.push({ path: dest, name: path.basename(dest), size: (await fsp.stat(dest)).size });
  }
  for (const s of subs) {
    const cues = parseVtt(await fsp.readFile(s.src, 'utf8')).cues;
    if (!cues.length) continue;
    const dest = path.join(cfg.outDir, `${stem}.${s.lang}.srt`);
    await fsp.writeFile(dest, toSrt(cues));
    files.push({ path: dest, name: path.basename(dest), size: (await fsp.stat(dest)).size });
  }
  return { files, separate };
}

async function remuxFiles(paths, out, signal, onProgress) {
  const inputs = [];
  for (const p of paths) {
    const blob = await fs.openAsBlob(p);
    inputs.push({ blob, parts: [[0, blob.size]] });
  }
  const r = await remuxToMp4(inputs, { scratch: new MemoryFile(), signal, onProgress });
  await pipeline(Readable.fromWeb(r.blob.stream()), fs.createWriteStream(out), { signal });
}

async function move(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
}

function cancel() {
  if (!current) return send({ type: 'canceled' });
  current.ctrl.abort();
  killAll();
}

async function cleanup(id) {
  if (!/^[\w-]{1,64}$/.test(id || '')) throw coded('BAD_REQUEST', 'Bad job id');
  await removeWork(loadConfig(), id);
}

/** Shows a file in Explorer / Finder / the file manager – only files in the output folder. */
function reveal(p) {
  const cfg = loadConfig();
  const target = path.resolve(String(p || ''));
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const inside = norm(target).startsWith(norm(cfg.outDir + path.sep));
  const file = inside && fs.existsSync(target) ? target : null;
  if (process.env.TVD_DRY_REVEAL) return { shown: file || cfg.outDir };
  const opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32')
    spawn('explorer.exe', [file ? `/select,"${file}"` : `"${cfg.outDir}"`], { ...opts, windowsVerbatimArguments: true }).unref();
  else if (process.platform === 'darwin') spawn('open', file ? ['-R', file] : [cfg.outDir], opts).unref();
  else spawn('xdg-open', [file ? path.dirname(file) : cfg.outDir], opts).unref();
  return { shown: file || cfg.outDir };
}

// ---------------------------------------------------------------- main loop
let inflight = 0;
let ended = false;

async function handle(msg) {
  inflight++;
  try {
    switch (msg?.cmd) {
      case 'probe':
        return send({ ok: true, ...(await probe()) });
      case 'info':
        return send({ ok: true, info: await info(msg.url) });
      case 'download':
        return await download(msg);
      case 'cancel':
        return cancel();
      case 'cleanup':
        await cleanup(msg.id);
        return send({ ok: true });
      case 'reveal':
        return send({ ok: true, ...reveal(msg.path) });
      default:
        throw coded('BAD_REQUEST', `Unknown command: ${msg?.cmd}`);
    }
  } catch (e) {
    if (e.code === 'CANCELED' || e.name === 'AbortError') send({ ok: false, type: 'canceled' });
    else {
      if (!['YTDLP', 'NO_YTDLP'].includes(e.code)) log(msg?.cmd, 'failed:', e.stack || e);
      send({ ok: false, type: 'error', code: e.code || 'HOST', error: e.message || String(e) });
    }
  } finally {
    inflight--;
    if (ended && !inflight) process.exit(0);
  }
}

let input = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  input = Buffer.concat([input, d]);
  while (input.length >= 4) {
    const len = input.readUInt32LE(0);
    if (input.length < 4 + len) break;
    const body = input.subarray(4, 4 + len).toString('utf8');
    input = input.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      send({ ok: false, type: 'error', code: 'BAD_REQUEST', error: 'Not JSON' });
      continue;
    }
    handle(msg);
  }
});

/** The browser closed the connection (e.g. the download was paused): stop yt-dlp and exit. */
function shutdown() {
  ended = true;
  current?.ctrl.abort();
  killAll();
  if (!inflight) process.exit(0);
  setTimeout(() => process.exit(0), 3000).unref();
}
process.stdin.on('end', shutdown);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdown);
process.stdout.on('error', () => {
  killAll();
  process.exit(0);
});
process.on('uncaughtException', (e) => {
  log('uncaught', e.stack || e);
  killAll();
  process.exit(1);
});
