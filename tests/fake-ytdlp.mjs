#!/usr/bin/env node
// A fake yt-dlp for the tests: understands the arguments the native host uses and behaves like
// yt-dlp – prints the info JSON (tests/fixtures/ytdlp-info.json), "downloads" formats (the recordings
// from tests/fixtures) into .part files with progress lines, resumes .part files, writes subtitles
// and merges video + audio (with the extension's remuxer – the real yt-dlp would run ffmpeg).
//
// Variables: FAKE_YTDLP_DELAY – ms per 8 KB chunk (slow download for pause tests),
// FAKE_YTDLP_ARGS – file to append the received arguments to (one JSON line per run),
// FAKE_YTDLP_PIDS – start a child process too and write both PIDs to this file (stopping must kill the whole tree).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remuxToMp4 } from '../lib/remux.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INFO = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/ytdlp-info.json'), 'utf8'));
const DATA = {
  video: fs.readFileSync(path.join(HERE, 'fixtures/rec-video.mp4')),
  audio: fs.readFileSync(path.join(HERE, 'fixtures/rec-audio.mp4'))
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
if (process.env.FAKE_YTDLP_ARGS) fs.appendFileSync(process.env.FAKE_YTDLP_ARGS, JSON.stringify(args) + '\n');

const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const url = args[args.indexOf('--') + 1] || args[args.length - 1];
const fail = (msg) => {
  process.stderr.write(`WARNING: something harmless\nERROR: [youtube] ${INFO.id}: ${msg}\n`);
  process.exit(1);
};

if (args.includes('--version')) {
  console.log('2099.01.01 (fake)');
  process.exit(0);
}
if (/private/.test(url)) fail('Private video. Sign in if you have been granted access to this video');
if (!/youtu/.test(url)) fail('Unsupported URL');

if (args.includes('-J')) {
  process.stdout.write(JSON.stringify(INFO));
  process.exit(0);
}

// ---------------------------------------------------------------- download
const work = opt('-P') || '.';
const spec = opt('-f');
const merge = spec.includes('+');
const ids = spec.split(merge ? '+' : ',');
const templates = all('-o');
const mainTpl = templates.find((t) => !/^\w+:/.test(t));
const subTpl = (templates.find((t) => t.startsWith('subtitle:')) || `subtitle:${mainTpl}`).slice(9);
const progressTpl = (opt('--progress-template') || '').replace(/^download:/, '');
const formatOf = (id) => INFO.formats.find((f) => f.format_id === id) || fail(`Requested format is not available: ${id}`);
const fill = (tpl, vals) => tpl.replace(/%\(([\w.]+)\)s/g, (m, k) => String(vals[k] ?? 'NA'));

if (process.env.FAKE_YTDLP_PIDS) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_YTDLP_PIDS, `${process.pid} ${child.pid}`);
}

async function fetchFormat(f, dest) {
  if (fs.existsSync(dest)) {
    console.log(`[download] ${dest} has already been downloaded`);
    return;
  }
  const data = f.vcodec !== 'none' ? DATA.video : DATA.audio;
  const part = dest + '.part';
  let pos = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (pos) console.log(`[download] Resuming download at byte ${pos}`);
  console.log(`[download] Destination: ${dest}`);
  const delay = Number(process.env.FAKE_YTDLP_DELAY || 0);
  while (pos < data.length) {
    const end = Math.min(data.length, pos + 8192);
    fs.appendFileSync(part, data.subarray(pos, end));
    pos = end;
    const line = fill(progressTpl, {
      'progress.downloaded_bytes': pos,
      'progress.total_bytes': data.length,
      'progress.speed': 1234567.5,
      'info.format_id': f.format_id
    });
    if (progressTpl) console.log(line);
    if (delay) await sleep(delay);
  }
  fs.renameSync(part, dest);
}

for (const lang of (opt('--sub-langs') || '').split(',').filter(Boolean)) {
  if (!INFO.subtitles[lang]) continue;
  const dest = path.join(work, fill(subTpl, { ext: 'vtt' }).replace(/\.vtt$/, `.${lang}.vtt`));
  fs.writeFileSync(dest, `WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n[${lang}] First line\n\n00:00:03.000 --> 00:00:04.000\n[${lang}] Second <c.yellow>line</c>\n`);
}

if (merge) {
  const final = path.join(work, fill(mainTpl, { ext: opt('--merge-output-format') || 'mkv' }));
  if (fs.existsSync(final)) console.log(`[download] ${final} has already been downloaded`);
  else {
    const parts = [];
    for (const id of ids) {
      const f = formatOf(id);
      const dest = final.replace(/\.[^.]+$/, `.f${id}.${f.ext}`);
      await fetchFormat(f, dest);
      parts.push(dest);
    }
    console.log(`[Merger] Merging formats into "${final}"`);
    const inputs = parts.map((p) => {
      const buf = fs.readFileSync(p);
      return { blob: new Blob([buf]), parts: [[0, buf.length]] };
    });
    const out = await remuxToMp4(inputs, {});
    fs.writeFileSync(final, Buffer.from(await out.blob.arrayBuffer()));
    parts.forEach((p) => fs.rmSync(p));
  }
} else {
  for (const id of ids) {
    const f = formatOf(id);
    await fetchFormat(f, path.join(work, fill(mainTpl, { format_id: id, ext: f.ext })));
  }
}
