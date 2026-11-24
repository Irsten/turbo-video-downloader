// Builds the store package: dist/turbo-video-downloader-<version>.zip with manifest.json at its root.
// Only runtime files go in (no tests, node_modules or configs). Before zipping it checks that every
// file referenced by the manifest, the HTML pages and the JS imports is part of the package.
// Run: npm run package
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT_FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js', 'manager.html', 'manager.js', 'ui.css'];
const DIRS = ['icons', 'lib', '_locales'];

const walk = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : [rel];
  });

const files = [...ROOT_FILES, ...DIRS.filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap(walk)].sort();
const included = new Set(files);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------- checks
const problems = [];
const need = (file, from) => {
  const rel = path.posix.normalize(file).replace(/^\.\//, '');
  if (!included.has(rel)) problems.push(`${from} references ${rel}, which is not in the package`);
};
need(manifest.background?.service_worker, 'manifest.json (background)');
for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) need(js, 'manifest.json (content_scripts)');
need(manifest.action?.default_popup, 'manifest.json (action)');
for (const p of Object.values({ ...manifest.icons, ...manifest.action?.default_icon })) need(p, 'manifest.json (icons)');
if (manifest.default_locale) need(`_locales/${manifest.default_locale}/messages.json`, 'manifest.json (default_locale)');

const messageKeys = (locale) => Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, `_locales/${locale}/messages.json`), 'utf8')));
const locales = files.filter((f) => /^_locales\/[^/]+\/messages\.json$/.test(f)).map((f) => f.split('/')[1]);
if (manifest.default_locale) {
  const base = new Set(messageKeys(manifest.default_locale));
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) if (!base.has(m[1])) problems.push(`manifest.json uses a missing message ${m[1]}`);
  for (const loc of locales) {
    const keys = new Set(messageKeys(loc));
    for (const k of base) if (!keys.has(k)) problems.push(`_locales/${loc} is missing the message ${k}`);
    for (const k of keys) if (!base.has(k)) problems.push(`_locales/${loc} has a message ${k} unknown in ${manifest.default_locale}`);
  }
}

for (const f of files) {
  const dir = path.posix.dirname(f);
  if (f.endsWith('.html')) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of html.matchAll(/\b(?:src|href)="([^":#?]+)"/g)) need(path.posix.join(dir, m[1]), f);
  } else if (f.endsWith('.js')) {
    const js = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of js.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) need(path.posix.join(dir, m[1]), f);
    for (const m of js.matchAll(/new URL\('(\.{1,2}\/[^']+)', import\.meta\.url\)/g)) need(path.posix.join(dir, m[1]), f);
  }
}
if (problems.length) {
  console.error('The package would be incomplete:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// ---------------------------------------------------------------- ZIP (deflate, no dependencies)
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const chunks = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = fs.readFileSync(path.join(ROOT, name));
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const store = packed.length >= data.length; // e.g. PNG – already compressed
  const body = store ? data : packed;
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // UTF-8 names
  header.writeUInt16LE(store ? 0 : 8, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  chunks.push(header, nameBuf, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4); // version made by
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(store ? 0 : 8, 10);
  entry.writeUInt16LE(dosTime, 12);
  entry.writeUInt16LE(dosDate, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBuf);
  offset += header.length + nameBuf.length + body.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = path.join(ROOT, 'dist', `turbo-video-downloader-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...chunks, ...central, end]));
console.log(`${path.relative(ROOT, out)} – ${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
