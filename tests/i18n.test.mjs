// Translations: every key used in the code and HTML exists, all languages have the same keys and
// substitutions, and the texts the stores show fit their limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr } from '../lib/i18n.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const locales = fs.readdirSync(path.join(ROOT, '_locales'));
const messages = Object.fromEntries(locales.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
const en = messages.en;

const sources = ['background.js', 'popup.js', 'manager.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => `lib/${f}`)].filter((f) =>
  f.endsWith('.js')
);

test('English is the default and Polish is available', () => {
  assert.equal(JSON.parse(read('manifest.json')).default_locale, 'en');
  assert.deepEqual(locales.sort(), ['en', 'pl']);
});

test('every key used in the code and HTML exists', () => {
  const used = new Map();
  for (const f of sources) {
    // tr('key'), tr(cond ? 'a' : 'b'), tr('key', value)
    for (const m of read(f).matchAll(/(?<![\w.$])tr\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      const head = m[1].split(',')[0];
      for (const k of head.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) used.set(k[1], f);
    }
  }
  for (const f of ['popup.html', 'manager.html']) {
    for (const m of read(f).matchAll(/data-i18n(?:-title|-placeholder)?="(\w+)"/g)) used.set(m[1], f);
  }
  for (const m of read('manifest.json').matchAll(/__MSG_(\w+)__/g)) used.set(m[1], 'manifest.json');
  assert.ok(used.size > 120, `found ${used.size} keys – the scan works`);
  const missing = [...used].filter(([k]) => !en[k]).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, []);
});

test('all languages have the same keys and the same substitutions', () => {
  const subs = (s) => [...s.matchAll(/\$([1-9])/g)].map((m) => m[1]).sort().join();
  for (const [lang, msgs] of Object.entries(messages)) {
    assert.deepEqual(Object.keys(msgs).sort(), Object.keys(en).sort(), `${lang}: different keys`);
    for (const [k, v] of Object.entries(msgs)) {
      assert.equal(subs(v.message), subs(en[k].message), `${lang}.${k}: different $n substitutions`);
      assert.ok(v.message.trim(), `${lang}.${k}: empty`);
    }
  }
});

test('store limits: name ≤ 45 and description ≤ 132 characters', () => {
  for (const [lang, msgs] of Object.entries(messages)) {
    assert.ok(msgs.extName.message.length <= 45, `${lang}: name too long`);
    assert.ok(msgs.extDescription.message.length <= 132, `${lang}: description has ${msgs.extDescription.message.length} characters`);
  }
});

test('outside the extension the English texts are used, with substitutions', () => {
  assert.equal(tr('errAccessDenied', 403), 'Access denied (HTTP 403) – the link may have expired or requires signing in.');
  assert.equal(tr('downloadedOf', '1 MB', '~2 MB'), '1 MB of ~2 MB');
  assert.equal(tr('noSuchKey'), 'noSuchKey', 'a missing key shows itself instead of an empty text');
});
