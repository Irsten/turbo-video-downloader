// Configuration of the native host: native/config.json (created by install.mjs, can be edited by hand),
// overridden by the TVD_* environment variables (used by the tests).
//
//   ytdlp      – yt-dlp program (a path, or a name found in PATH); a .js/.mjs file is run with Node
//   ffmpeg     – ffmpeg program; "" or "none" = don't use ffmpeg (video and audio are then merged
//                by the extension's own remuxer, which handles MP4/M4A only)
//   outDir     – where finished files go (default: the system downloads folder)
//   extraArgs  – extra yt-dlp arguments, e.g. ["--cookies", "C:/Users/me/cookies.txt"]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.TVD_CONFIG || path.join(HERE, 'config.json');

/** The downloads folder – on Windows it may have been moved, so it is read from the registry. */
export function defaultDownloads() {
  if (process.platform === 'win32') {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
      { encoding: 'utf8', windowsHide: true }
    );
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(r.stdout || '');
    if (m) return m[1].trim().replace(/%([^%]+)%/g, (s, v) => process.env[v] ?? s);
  }
  return path.join(os.homedir(), 'Downloads');
}

export function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * A program given by its bare name is also looked for where winget puts its links: a browser started
 * before yt-dlp/ffmpeg were installed passes the helper an older PATH.
 */
function locate(value, name) {
  if (value !== name || process.platform !== 'win32' || !process.env.LOCALAPPDATA) return value;
  const link = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', `${name}.exe`);
  return fs.existsSync(link) ? link : value;
}

let downloads = null;
export function loadConfig() {
  const file = readConfigFile();
  const env = process.env;
  const ffmpeg = locate(String(env.TVD_FFMPEG ?? file.ffmpeg ?? 'ffmpeg').trim(), 'ffmpeg');
  return {
    ytdlp: env.TVD_YTDLP || locate(file.ytdlp || 'yt-dlp', 'yt-dlp'),
    ffmpeg: /^(|none|off|false)$/i.test(ffmpeg) ? '' : ffmpeg,
    outDir: path.resolve(env.TVD_OUTDIR || file.outDir || (downloads ??= defaultDownloads())),
    extra: Array.isArray(file.extraArgs) ? file.extraArgs.map(String) : []
  };
}
