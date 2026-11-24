// YouTube through yt-dlp (personal build): the helpers of the native host, and the host itself
// (native/host.mjs) driven the way the browser does it – with a fake yt-dlp (tests/fake-ytdlp.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactInfo, downloadArgs, parseProgress, errorMessage, safeName, checkRequest, codecName } from '../native/ytdlp.mjs';
import { youtubeVideoId, pageVideoCount } from '../lib/external.js';
import { children, fourcc } from '../lib/mp4.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ytdlp-info.json'), 'utf8'));
const VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const REC_SIZE = fs.statSync(path.join(ROOT, 'tests/fixtures/rec-video.mp4')).size + fs.statSync(path.join(ROOT, 'tests/fixtures/rec-audio.mp4')).size;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- addresses
test('YouTube video addresses', () => {
  const id = 'aqz-KE-bpKQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?list=PL1&v=${id}&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?t=10`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`
  ])
    assert.equal(youtubeVideoId(url), id, url);
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com.evil.example/watch?v=${id}`,
    `https://notyoutube.com/watch?v=${id}`,
    `ftp://youtu.be/${id}`,
    'not a url'
  ])
    assert.equal(youtubeVideoId(url), null, url);
  assert.equal(pageVideoCount(`https://youtu.be/${id}`), 1);
  assert.equal(pageVideoCount('https://www.youtube.com/feed/subscriptions'), 0);
});

// ---------------------------------------------------------------- yt-dlp's JSON -> the popup's description
test('description of a video without ffmpeg: MP4 + M4A only, WebM-only qualities need ffmpeg', () => {
  const info = compactInfo(INFO, { ffmpeg: false });
  assert.equal(info.title, INFO.title);
  assert.equal(info.channel, 'Test channel');
  assert.equal(info.live, false);
  assert.deepEqual(
    info.qualities.map((q) => [q.label, q.video, q.audio, q.codec, q.needsFfmpeg]),
    [
      ['1440p60', '308', '140', 'VP9', true],
      ['1080p60', '299', '140', 'H.264', false], // 60 fps before 30 fps
      ['720p', '136', '140', 'H.264', false], // MP4 before WebM
      ['360p', '134', '140', 'H.264', false] // the format with both (18) isn't needed
    ],
    'no storyboards, HLS or DRM formats'
  );
  assert.equal(info.qualities[1].size, 109081 + 99529);
  assert.equal(info.qualities[3].size, 300 * 125 * 8 + 99529, 'size from the bit rate when yt-dlp gives none');
  assert.deepEqual(info.audio, { audio: '140', ext: 'm4a', size: 99529 }, 'the best M4A, not the DRC version');
  assert.deepEqual(info.subtitles, [
    { lang: 'en', name: 'English' },
    { lang: 'pl', name: 'Polish' }
  ], 'only subtitles available as WebVTT, no live chat or automatic captions');
});

test('description with ffmpeg; a video with combined formats only; a live stream', () => {
  assert.equal(compactInfo(INFO, { ffmpeg: true }).qualities[0].needsFfmpeg, false);
  const old = compactInfo({
    duration: 10,
    formats: [
      { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360, filesize: 1000 },
      { format_id: '22', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720, filesize: 3000 }
    ]
  });
  assert.deepEqual(old.qualities.map((q) => [q.label, q.video, q.audio, q.size]), [
    ['720p', '22', null, 3000],
    ['360p', '18', null, 1000]
  ]);
  assert.equal(old.audio, null);
  assert.equal(compactInfo({ live_status: 'is_live', formats: [] }).live, true);
  assert.equal(codecName('av01.0.08M.08'), 'AV1');
  assert.equal(codecName('hvc1.1.6.L120'), 'H.265');
});

// ---------------------------------------------------------------- command line
test('yt-dlp arguments: merging by yt-dlp (ffmpeg) or separate files, subtitles, URL after --', () => {
  const msg = { id: 'job1', url: VIDEO_URL, video: '299', audio: '140', subs: ['en', 'pt-BR'] };
  const withFfmpeg = downloadArgs(msg, { ffmpeg: true, ffmpegPath: 'C:/ffmpeg/bin/ffmpeg.exe', work: '/w', extra: ['--cookies', 'c.txt'] });
  assert.equal(withFfmpeg.merge, true);
  const a = withFfmpeg.args;
  assert.deepEqual(a.slice(a.indexOf('-f'), a.indexOf('-f') + 4), ['-f', '299+140', '--merge-output-format', 'mp4']);
  assert.ok(a.includes('--write-subs') && a[a.indexOf('--sub-langs') + 1] === 'en,pt-BR');
  assert.ok(a.includes('subtitle:v.%(ext)s'));
  assert.equal(a[a.indexOf('--ffmpeg-location') + 1], 'C:/ffmpeg/bin/ffmpeg.exe');
  assert.deepEqual(a.slice(-4), ['--cookies', 'c.txt', '--', VIDEO_URL]);
  assert.equal(a[a.indexOf('-P') + 1], '/w');

  const without = downloadArgs({ ...msg, subs: [] }, { ffmpeg: false, work: '/w' });
  assert.equal(without.merge, false);
  assert.equal(without.args[without.args.indexOf('-f') + 1], '299,140');
  assert.ok(without.args.includes('f%(format_id)s.%(ext)s'));
  assert.ok(!without.args.includes('--write-subs'));
  assert.equal(downloadArgs({ ...msg, video: null }, { ffmpeg: true, work: '/w' }).merge, false, 'audio alone is never merged');
});

test('a request with options in disguise is refused', () => {
  const ok = { id: 'job1', url: VIDEO_URL, video: '137', audio: '140', subs: ['en'] };
  checkRequest(ok);
  for (const bad of [
    { url: '--exec calc.exe' },
    { url: 'file:///etc/passwd' },
    { url: `${VIDEO_URL} --exec x` },
    { id: '../x' },
    { video: '137 --exec x' },
    { video: null, audio: null },
    { subs: ['en,--exec'] }
  ])
    assert.throws(() => checkRequest({ ...ok, ...bad }), { code: 'BAD_REQUEST' }, JSON.stringify(bad));
});

test('progress lines, error messages, file names', () => {
  assert.deepEqual(parseProgress('TVD 1024 4096 NA 512.5 137'), { downloaded: 1024, total: 4096, speed: 512.5, format: '137' });
  assert.deepEqual(parseProgress('TVD 1024 NA 5000.0 NA 140'), { downloaded: 1024, total: 5000, speed: null, format: '140' });
  assert.equal(parseProgress('[download]  12.5% of 10.00MiB'), null);
  assert.equal(parseProgress('TVD NA NA NA NA 140'), null);

  assert.equal(errorMessage('WARNING: x\nERROR: [youtube] aqz-KE-bpKQ: Sign in to confirm your age\n'), 'Sign in to confirm your age');
  assert.equal(errorMessage('Traceback…\nKeyError: x\n'), 'KeyError: x');
  assert.equal(errorMessage('', 2), 'yt-dlp exited with code 2');

  assert.equal(safeName('Big: test / video?'), 'Big test video');
  assert.equal(safeName('..hidden. '), 'hidden');
  assert.equal(safeName('CON'), 'video');
  assert.equal(safeName(''), 'video');
  assert.equal(Array.from(safeName('😀'.repeat(200))).length, 120, 'cut by characters, no broken emoji');
});

// ---------------------------------------------------------------- the host itself
/** Starts native/host.mjs with the fake yt-dlp; talks to it like the browser does. */
function startHost(env = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tvd-host-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'native/host.mjs')], {
    env: {
      ...process.env,
      TVD_YTDLP: path.join(ROOT, 'tests/fake-ytdlp.mjs'),
      TVD_FFMPEG: 'none',
      TVD_OUTDIR: out,
      TVD_LOG: path.join(os.tmpdir(), `tvd-host-test-${process.pid}.log`),
      TVD_CONFIG: path.join(out, 'no-config.json'),
      ...env
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const exited = new Promise((r) => proc.once('exit', r));
  const msgs = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const n = buf.readUInt32LE(0);
      msgs.push(JSON.parse(buf.subarray(4, 4 + n).toString('utf8')));
      buf = buf.subarray(4 + n);
    }
  });
  let cursor = 0;
  const send = (o) => {
    const body = Buffer.from(JSON.stringify(o), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    proc.stdin.write(Buffer.concat([head, body]));
  };
  /** The next message (after the ones already taken) that matches. */
  const next = async (pred = () => true, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = msgs.findIndex((m, n) => n >= cursor && pred(m));
      if (i >= 0) {
        cursor = i + 1;
        return msgs[i];
      }
      await sleep(20);
    }
    throw new Error(`no matching message; last: ${JSON.stringify(msgs.slice(-3))}`);
  };
  const request = (o, pred = (m) => 'ok' in m) => {
    cursor = msgs.length;
    send(o);
    return next(pred);
  };
  const finished = (m) => ['done', 'error', 'canceled'].includes(m.type);
  const close = async () => {
    proc.stdin.end();
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(out, { recursive: true, force: true });
  };
  return { out, send, next, request, msgs, finished, close, exited, proc };
}

/** Tracks of an MP4 file: handler and sample count. */
function tracksOf(file) {
  const u8 = new Uint8Array(fs.readFileSync(file));
  const top = [...children(u8, 0, u8.length)];
  const moov = top.find((b) => b.type === 'moov');
  const find = (box, ...p) => p.reduce((b, t) => b && [...children(u8, b.body, b.end)].find((c) => c.type === t), box);
  return {
    top: top.map((b) => b.type),
    tracks: [...children(u8, moov.body, moov.end)]
      .filter((b) => b.type === 'trak')
      .map((trak) => fourcc(u8, find(trak, 'mdia', 'hdlr').body + 8))
  };
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

test('host: probe and video description', async () => {
  const h = startHost();
  try {
    const p = await h.request({ cmd: 'probe' });
    assert.equal(p.ok, true);
    assert.equal(p.ytdlp, '2099.01.01 (fake)');
    assert.equal(p.ffmpeg, false);
    assert.equal(p.outDir, path.resolve(h.out));
    const r = await h.request({ cmd: 'info', url: VIDEO_URL });
    assert.deepEqual(r.info, compactInfo(INFO, { ffmpeg: false }));
    const bad = await h.request({ cmd: 'info', url: '--version' });
    assert.deepEqual([bad.ok, bad.code], [false, 'BAD_REQUEST']);
    const unknown = await h.request({ cmd: 'format-c' });
    assert.equal(unknown.code, 'BAD_REQUEST');
  } finally {
    await h.close();
  }
});

test('host: no yt-dlp, yt-dlp errors', async () => {
  const missing = startHost({ TVD_YTDLP: path.join(os.tmpdir(), 'no-such-dir', 'yt-dlp-missing') });
  try {
    const p = await missing.request({ cmd: 'probe' });
    assert.deepEqual([p.ok, p.ytdlp, p.error], [true, null, 'NO_YTDLP']);
    const i = await missing.request({ cmd: 'info', url: VIDEO_URL });
    assert.equal(i.code, 'NO_YTDLP');
  } finally {
    await missing.close();
  }
  const h = startHost();
  try {
    const e = await h.request({ cmd: 'info', url: 'https://www.youtube.com/watch?v=private1234' });
    assert.equal(e.code, 'YTDLP');
    assert.match(e.error, /^Private video/);
    h.send({ cmd: 'download', id: 'job1', url: 'https://www.youtube.com/watch?v=private1234', video: '137', audio: '140', filename: 'x' });
    const d = await h.next(h.finished);
    assert.deepEqual([d.type, d.code], ['error', 'YTDLP']);
  } finally {
    await h.close();
  }
});

test('host: download without ffmpeg – merged into one MP4 by the extension remuxer, subtitles as SRT, free names', async () => {
  const h = startHost();
  try {
    const job = { cmd: 'download', id: 'job1', url: VIDEO_URL, video: '299', audio: '140', subs: ['en', 'pl'], filename: 'Bunny: test', size: REC_SIZE };
    h.send(job);
    const done = await h.next(h.finished);
    assert.equal(done.type, 'done', JSON.stringify(done));
    assert.deepEqual(done.files.map((f) => f.name), ['Bunny test.mp4', 'Bunny test.en.srt', 'Bunny test.pl.srt']);
    assert.equal(done.separate, false);
    const mp4 = tracksOf(done.files[0].path);
    assert.deepEqual(mp4.top, ['ftyp', 'moov', 'mdat'], 'a regular MP4, not fragmented');
    assert.deepEqual(mp4.tracks, ['vide', 'soun']);
    assert.equal(done.files[0].size, fs.statSync(done.files[0].path).size);
    const srt = fs.readFileSync(done.files[1].path, 'utf8');
    assert.match(srt, /^1\r?\n00:00:01,000 --> 00:00:02,500\r?\n\[en\] First line/);
    assert.match(srt, /Second line/, 'WebVTT-only tags removed');

    const progress = h.msgs.filter((m) => m.type === 'progress');
    assert.ok(progress.length >= 1);
    const last = progress.at(-1);
    assert.equal(last.loaded, REC_SIZE);
    assert.equal(last.total, REC_SIZE);
    assert.ok(h.msgs.some((m) => m.type === 'phase' && m.phase === 'remux'));
    assert.ok(!fs.existsSync(path.join(h.out, '.turbo-video-downloader')), 'working folder removed');

    // The same name again: "(1)" for the video and its subtitles together.
    h.send({ ...job, id: 'job2' });
    const again = await h.next(h.finished);
    assert.deepEqual(again.files.map((f) => f.name), ['Bunny test (1).mp4', 'Bunny test (1).en.srt', 'Bunny test (1).pl.srt']);
  } finally {
    await h.close();
  }
});

test('host: audio only → a regular .m4a; with ffmpeg yt-dlp merges', async () => {
  const h = startHost();
  try {
    h.send({ cmd: 'download', id: 'a1', url: VIDEO_URL, audio: '140', filename: 'Song', size: 99529 });
    const done = await h.next(h.finished);
    assert.deepEqual(done.files.map((f) => f.name), ['Song.m4a']);
    assert.deepEqual(tracksOf(done.files[0].path).tracks, ['soun']);
  } finally {
    await h.close();
  }
  const argsLog = path.join(os.tmpdir(), `tvd-fake-args-${process.pid}.txt`);
  fs.rmSync(argsLog, { force: true });
  const f = startHost({ TVD_FFMPEG: path.join(ROOT, 'tests/fake-ffmpeg.mjs'), FAKE_YTDLP_ARGS: argsLog });
  try {
    assert.equal((await f.request({ cmd: 'probe' })).ffmpeg, true);
    f.send({ cmd: 'download', id: 'm1', url: VIDEO_URL, video: '308', audio: '140', filename: 'Merged', size: REC_SIZE });
    const done = await f.next(f.finished);
    assert.equal(done.type, 'done', JSON.stringify(done));
    assert.deepEqual(done.files.map((x) => x.name), ['Merged.mp4']);
    assert.deepEqual(tracksOf(done.files[0].path).tracks, ['vide', 'soun']);
    assert.ok(f.msgs.some((m) => m.type === 'phase' && m.phase === 'merge'));
    const args = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(args[args.indexOf('-f') + 1], '308+140');
    assert.equal(args[args.indexOf('--ffmpeg-location') + 1], path.join(ROOT, 'tests/fake-ffmpeg.mjs'));
  } finally {
    await f.close();
    fs.rmSync(argsLog, { force: true });
  }
});

test('host: pause (cancel) keeps the partial file, the next run continues it', async () => {
  const h = startHost({ FAKE_YTDLP_DELAY: '40' });
  try {
    const job = { cmd: 'download', id: 'p1', url: VIDEO_URL, video: '137', audio: '140', filename: 'Paused', size: REC_SIZE };
    h.send(job);
    const first = await h.next((m) => m.type === 'progress' && m.loaded > 30000);
    h.send({ cmd: 'cancel' });
    assert.equal((await h.next(h.finished)).type, 'canceled');
    const work = path.join(h.out, '.turbo-video-downloader', 'p1');
    const parts = fs.readdirSync(work).filter((n) => n.endsWith('.part'));
    assert.deepEqual(parts, ['f137.mp4.part']);
    const kept = fs.statSync(path.join(work, parts[0])).size;
    assert.ok(kept >= first.loaded, `kept ${kept} bytes`);

    h.send(job);
    const resumed = await h.next((m) => m.type === 'progress');
    assert.ok(resumed.loaded > kept, `resumed at ${resumed.loaded}, not from zero`);
    const done = await h.next(h.finished);
    assert.equal(done.type, 'done', JSON.stringify(done));
    assert.deepEqual(tracksOf(done.files[0].path).tracks, ['vide', 'soun'], 'the resumed file is whole');

    // Removing a job: its partial files go away.
    h.send({ ...job, id: 'p2' });
    await h.next((m) => m.type === 'progress');
    h.send({ cmd: 'cancel' });
    await h.next(h.finished);
    assert.ok(fs.existsSync(path.join(h.out, '.turbo-video-downloader', 'p2')));
    assert.equal((await h.request({ cmd: 'cleanup', id: 'p2' })).ok, true);
    assert.ok(!fs.existsSync(path.join(h.out, '.turbo-video-downloader')));
  } finally {
    await h.close();
  }
});

test('host: when the browser closes the connection, yt-dlp and its child processes stop', async () => {
  const pids = path.join(os.tmpdir(), `tvd-fake-pids-${process.pid}.txt`);
  fs.rmSync(pids, { force: true });
  const h = startHost({ FAKE_YTDLP_DELAY: '50', FAKE_YTDLP_PIDS: pids });
  try {
    h.send({ cmd: 'download', id: 'k1', url: VIDEO_URL, video: '137', audio: '140', filename: 'Killed' });
    await h.next((m) => m.type === 'progress');
    const [ytdlp, child] = fs.readFileSync(pids, 'utf8').split(' ').map(Number);
    assert.ok(isAlive(ytdlp) && isAlive(child));
    h.proc.stdin.end(); // what the browser does when the port is closed
    await Promise.race([h.exited, sleep(5000)]);
    assert.notEqual(h.proc.exitCode, null, 'the host exited');
    for (let i = 0; i < 25 && (isAlive(ytdlp) || isAlive(child)); i++) await sleep(200);
    assert.ok(!isAlive(ytdlp), 'yt-dlp stopped');
    assert.ok(!isAlive(child), 'its child process stopped too');
  } finally {
    await h.close();
    fs.rmSync(pids, { force: true });
  }
});

test('host: showing a file – only inside the output folder', async () => {
  const h = startHost({ TVD_DRY_REVEAL: '1' });
  try {
    const file = path.join(h.out, 'Video.mp4');
    fs.writeFileSync(file, 'x');
    assert.equal((await h.request({ cmd: 'reveal', path: file })).shown, file);
    assert.equal((await h.request({ cmd: 'reveal', path: path.join(os.homedir(), 'secret.txt') })).shown, path.resolve(h.out));
    assert.equal((await h.request({ cmd: 'reveal', path: path.join(h.out, 'gone.mp4') })).shown, path.resolve(h.out));
  } finally {
    await h.close();
  }
});
