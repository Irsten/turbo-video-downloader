// User-facing texts live in _locales/<language>/messages.json and are read through chrome.i18n
// (English is the default locale). Outside the extension – in Node tests – the English file is
// read directly, so the library gives the same messages there.

const api = globalThis.chrome?.i18n?.getMessage ? globalThis.chrome.i18n : null;
let fallback = null;

/** English messages read straight from the file (Node only; no top-level await – the service worker forbids it). */
function english() {
  if (!fallback) {
    const fs = globalThis.process?.getBuiltinModule?.('node:fs');
    fallback = fs ? JSON.parse(fs.readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8')) : {};
  }
  return fallback;
}

/** Translated message; $1…$9 in the message are replaced with the given values. */
export function tr(key, ...values) {
  const subs = values.flat().map(String);
  if (api) {
    const m = api.getMessage(key, subs);
    if (m) return m;
  }
  const entry = english()[key];
  if (!entry) return key;
  return entry.message.replace(/\$(\$|[1-9])/g, (m, d) => (d === '$' ? '$' : subs[d - 1] ?? ''));
}

/**
 * Translates static HTML: data-i18n (text), data-i18n-title, data-i18n-placeholder.
 * The English text stays in the HTML as a default.
 */
export function localize(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = tr(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tr(el.dataset.i18nPlaceholder);
  if (root.documentElement && api?.getUILanguage) root.documentElement.lang = api.getUILanguage().split('-')[0];
}
