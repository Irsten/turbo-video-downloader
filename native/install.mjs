#!/usr/bin/env node
// Registers the YouTube helper (native/host.mjs) with the browsers of the current user, so that the
// extension can start it (native messaging). Nothing is copied: the browsers run host.mjs from this folder.
//
//   node native/install.mjs <extension-id> [<more ids>]   – register (the ID is shown in the manager's YouTube panel)
//   node native/install.mjs --uninstall                   – remove the registration
//
// Windows: registry keys under HKCU\Software\<browser>\NativeMessagingHosts (Chrome's key is also read by
// Opera and Vivaldi). macOS / Linux: a manifest file in each browser's NativeMessagingHosts folder.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERE, CONFIG_PATH, readConfigFile, defaultDownloads } from './config.mjs';

export const HOST_NAME = 'com.turbovd.ytdlp';
const MANIFEST = path.join(HERE, `${HOST_NAME}.json`);
const WIN = process.platform === 'win32';
const WRAPPER = path.join(HERE, WIN ? 'host.cmd' : 'host.sh');
const WIN_BROWSERS = ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser'];
const home = os.homedir();
const UNIX_DIRS =
  process.platform === 'darwin'
    ? ['Google/Chrome', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Vivaldi'].map((b) => path.join(home, 'Library/Application Support', b))
    : ['google-chrome', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi'].map((b) => path.join(home, '.config', b));

const reg = (...args) => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
const winKey = (browser) => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`;

/** Full path of a program found in PATH (on Windows an .exe – .cmd shims can't be started directly). */
function which(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const found = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (WIN ? found.find((f) => /\.exe$/i.test(f)) : found[0]) || null;
}

function version(cmd, arg) {
  const js = /\.[cm]?js$/i.test(cmd);
  const r = spawnSync(js ? process.execPath : cmd, js ? [cmd, arg] : [arg], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function uninstall() {
  if (WIN) for (const b of WIN_BROWSERS) reg('delete', winKey(b), '/f');
  else for (const dir of UNIX_DIRS) fs.rmSync(path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`), { force: true });
  fs.rmSync(MANIFEST, { force: true });
  fs.rmSync(WRAPPER, { force: true });
  console.log('The helper is no longer registered (native/config.json was kept).');
}

function install(ids) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 16)) throw new Error(`Node 20.16 or newer is needed (this is ${process.version}).`);

  // The browsers start a program, not a script: a small wrapper runs host.mjs with this Node.
  if (WIN) fs.writeFileSync(WRAPPER, `@echo off\r\n"${process.execPath}" "%~dp0host.mjs" %*\r\n`);
  else {
    fs.writeFileSync(WRAPPER, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/host.mjs" "$@"\n`);
    fs.chmodSync(WRAPPER, 0o755);
  }

  // Extensions allowed earlier stay allowed (e.g. the same folder loaded in two browsers).
  let origins = [];
  try {
    origins = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).allowed_origins || [];
  } catch {
    // first installation
  }
  origins = [...new Set([...origins, ...ids.map((id) => `chrome-extension://${id}/`)])];
  const manifest = {
    name: HOST_NAME,
    description: 'Turbo Video Downloader – YouTube downloads with yt-dlp',
    path: WRAPPER,
    type: 'stdio',
    allowed_origins: origins
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  const registered = [];
  if (WIN) {
    for (const b of WIN_BROWSERS) {
      // Chrome's key always (Opera and Vivaldi read it too), the others only when the browser is installed.
      if (b !== 'Google\\Chrome' && reg('query', `HKCU\\Software\\${b}`).status !== 0) continue;
      const r = reg('add', winKey(b), '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f');
      if (r.status !== 0) throw new Error(`Could not write ${winKey(b)}: ${r.stderr || r.stdout}`);
      registered.push(b.replace('\\', ' '));
    }
  } else {
    for (const dir of UNIX_DIRS) {
      if (!fs.existsSync(dir) && !dir.includes('google-chrome') && !dir.endsWith('Google/Chrome')) continue;
      fs.mkdirSync(path.join(dir, 'NativeMessagingHosts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n');
      registered.push(path.basename(dir));
    }
  }

  // Configuration: created once, then it's yours to edit. Programs found in PATH are written with their
  // full path – a browser that was started before they were installed would not find them by name.
  const saved = fs.existsSync(CONFIG_PATH) ? readConfigFile() : { outDir: defaultDownloads(), extraArgs: [] };
  const config = { ...saved, ytdlp: saved.ytdlp || 'yt-dlp', ffmpeg: saved.ffmpeg ?? 'ffmpeg' };
  if (config.ytdlp === 'yt-dlp') config.ytdlp = which('yt-dlp') || 'yt-dlp';
  if (config.ffmpeg === 'ffmpeg') config.ffmpeg = which('ffmpeg') || 'ffmpeg';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  const ytdlpFound = version(config.ytdlp, '--version');
  const ffmpegFound = config.ffmpeg && version(config.ffmpeg, '-version');

  console.log(`Registered for: ${registered.join(', ')}`);
  console.log(`Allowed extensions: ${origins.join(' ')}`);
  console.log(`Configuration: ${CONFIG_PATH}`);
  console.log(`Files will be saved in: ${config.outDir || defaultDownloads()}`);
  console.log(ytdlpFound ? `yt-dlp: ${ytdlpFound}` : 'yt-dlp: NOT FOUND – install it (e.g. "winget install yt-dlp.yt-dlp", "brew install yt-dlp") or set "ytdlp" in the configuration.');
  console.log(
    ffmpegFound
      ? `ffmpeg: ${ffmpegFound.split(' Copyright')[0]}`
      : 'ffmpeg: not found (optional – without it qualities available only as WebM, usually above 1080p, are off; "winget install Gyan.FFmpeg", "brew install ffmpeg").'
  );
  console.log('Done. In the manager click "Check again" in the YouTube panel.');
}

const args = process.argv.slice(2);
try {
  if (args.includes('--uninstall')) uninstall();
  else {
    const ids = args.filter((a) => !a.startsWith('-'));
    if (!ids.length || ids.some((id) => !/^[a-p]{32}$/.test(id))) {
      console.error('Usage: node native/install.mjs <extension-id> [<more ids>]   (the ID is shown in the manager\'s YouTube panel)');
      console.error('       node native/install.mjs --uninstall');
      process.exit(2);
    }
    install(ids);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
