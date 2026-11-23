// Uruchamianie Chrome na tymczasowym profilu i sterowanie nim przez CDP (pipe).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Nie znaleziono Chrome – podaj ścieżkę w zmiennej CHROME.');
  return found;
}

/** Czeka, aż fn() zwróci prawdziwą wartość (wyjątki traktuje jak „jeszcze nie”). */
export async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  return last instanceof Error ? null : last;
}

/** Na Windowsie pliki profilu bywają jeszcze chwilę zablokowane po zamknięciu Chrome. */
async function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  console.warn(`Nie udało się usunąć ${dir} (pliki wciąż zablokowane) – możesz go skasować ręcznie.`);
}

/**
 * Uruchamia Chrome. Zwraca { send, evaluate, openTarget, close, downloads, work, stderr() }.
 * downloads – folder pobrań profilu.
 */
export async function launchChrome({ headful = !!process.env.HEADFUL, keep = !!process.env.KEEP } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tvd-e2e-'));
  const profile = path.join(work, 'profile');
  const downloads = path.join(work, 'downloads');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } })
  );

  const proc = spawn(
    findChrome(),
    [
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      ...(headful ? [] : ['--headless=new']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
  );
  let stderr = '';
  proc.stdio[2].on('data', (d) => (stderr += d));
  const pipeWrite = proc.stdio[3];
  let msgId = 0;
  const pending = new Map();
  let buf = Buffer.alloc(0);
  proc.stdio[4].on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
      buf = buf.subarray(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message + ' ' + (msg.error.data || ''))) : resolve(msg.result);
      }
    }
  });

  function send(method, params = {}, sessionId) {
    const id = ++msgId;
    pipeWrite.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  async function evaluate(sessionId, expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function openTarget(url) {
    const { targetId } = await send('Target.createTarget', { url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }
  async function close() {
    const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    await Promise.race([send('Browser.close').catch(() => {}), sleep(3000)]);
    await Promise.race([exited, sleep(5000)]);
    proc.kill();
    if (keep) console.log('Profil i pobrane pliki:', work);
    else await removeDir(work);
  }
  await send('Browser.getVersion');
  return { send, evaluate, openTarget, close, downloads, work, stderr: () => stderr };
}
