// Merging into MP4 (lib/remux.js) in Node: structure of the output on real recordings.
// Playback of the same variants in Chrome is checked by `npm run test:remux`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remuxToMp4, UnsupportedError } from '../lib/remux.js';
import { children, boxAt, fourcc, u32 } from '../lib/mp4.js';
import { MemoryFile } from '../lib/store.js';
import { loadFixtures, buildTs, buildPackedAac, splitFmp4 } from './media.mjs';

const fx = loadFixtures();
const SEG = [0, 2, 4, 6, 8];

function input(buffers) {
  const parts = [];
  let pos = 0;
  for (const b of buffers) {
    parts.push([pos, b.length]);
    pos += b.length;
  }
  return { blob: new Blob(buffers), parts };
}
const tsSegments = (opt = {}) => {
  const cc = { v: { cc: 0 }, a: { cc: 0 }, psi: 0 };
  return SEG.slice(0, -1).map((s, i) => buildTs(fx, s, SEG[i + 1], { ...opt, cc }));
};

/** Tracks of an MP4 file: type, sample count, timescale, number of key frames. */
async function inspect(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const top = [...children(u8, 0, u8.length)];
  const moov = top.find((b) => b.type === 'moov');
  const find = (box, ...path) =>
    path.reduce((b, t) => b && [...children(u8, b.body, b.end)].find((c) => c.type === t), box);
  const tracks = [...children(u8, moov.body, moov.end)]
    .filter((b) => b.type === 'trak')
    .map((trak) => {
      const stbl = find(trak, 'mdia', 'minf', 'stbl');
      const stsz = find(stbl, 'stsz');
      const stss = find(stbl, 'stss');
      const mdhd = find(trak, 'mdia', 'mdhd');
      return {
        handler: fourcc(u8, find(trak, 'mdia', 'hdlr').body + 8),
        codec: fourcc(u8, find(stbl, 'stsd').body + 12),
        samples: u32(u8, stsz.body + 8),
        timescale: u32(u8, mdhd.body + 12),
        keys: stss ? u32(u8, stss.body + 4) : null,
        ctts: !!find(stbl, 'ctts'),
        edits: u32(u8, find(trak, 'edts', 'elst').body + 4)
      };
    });
  return { top: top.map((b) => b.type), tracks };
}

test('TS (video + audio) → MP4 with H.264 and AAC, starting from a key frame', async () => {
  const out = await remuxToMp4([input(tsSegments())], { scratch: new MemoryFile() });
  const info = await inspect(out.blob);
  assert.deepEqual(info.top, ['ftyp', 'moov', 'mdat'], 'moov before mdat – playback starts right away');
  assert.deepEqual(info.tracks.map((t) => [t.handler, t.codec]), [['vide', 'avc1'], ['soun', 'mp4a']]);
  assert.equal(info.tracks[0].samples, fx.video.length);
  assert.equal(info.tracks[0].keys, fx.video.filter((f) => f.key).length);
  assert.equal(info.tracks[1].samples, fx.audio.length);
  assert.equal(info.tracks[1].timescale, 48000);
  assert.equal(out.start, 10, 'start on the source timeline (for aligning subtitles)');
  assert.ok(Math.abs(out.duration - 8) < 0.05, `duration ${out.duration}`);
});

test('TS with a PTS offset → ctts and an edit list with a delay', async () => {
  const out = await remuxToMp4([input(tsSegments({ cto: 2 }))], { scratch: new MemoryFile() });
  const info = await inspect(out.blob);
  assert.equal(info.tracks[0].ctts, true);
  assert.equal(info.tracks[0].edits, 2, 'empty edit (video delay) + the actual one');
});

test('TS without audio + packed AAC → one file with two tracks', async () => {
  const video = input(tsSegments({ audio: false }));
  const audio = input(SEG.slice(0, -1).map((s, i) => buildPackedAac(fx, s, SEG[i + 1])));
  const info = await inspect((await remuxToMp4([video, audio], { scratch: new MemoryFile() })).blob);
  assert.deepEqual(info.tracks.map((t) => t.samples), [fx.video.length, fx.audio.length]);
});

test('fMP4 in segments (init + fragments) → regular MP4', async () => {
  const v = splitFmp4(fx.recVideo);
  const a = splitFmp4(fx.recAudio);
  const out = await remuxToMp4([input([v.init, ...v.fragments]), input([a.init, ...a.fragments])], {});
  const info = await inspect(out.blob);
  assert.deepEqual(info.tracks.map((t) => t.handler), ['vide', 'soun']);
  assert.equal(info.tracks[0].samples, 200);
  assert.ok(Math.abs(out.duration - 8) < 0.1);
});

test('unsupported: AC-3 in TS, WebM, garbage', async () => {
  const ts = Buffer.from(tsSegments()[0]);
  // Change the audio stream type in the PMT from AAC (0x0f) to AC-3 (0x81).
  const pmt = ts.subarray(188, 376);
  pmt[pmt.indexOf(0x0f, 17)] = 0x81;
  await assert.rejects(remuxToMp4([input([ts])], { scratch: new MemoryFile() }), (e) => e instanceof UnsupportedError && /AC-3/.test(e.message));
  await assert.rejects(remuxToMp4([input([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])])], {}), UnsupportedError);
  await assert.rejects(remuxToMp4([input([Buffer.from('hello world, not a video')])], {}), UnsupportedError);
});

test('large file: the output is made of slices of the sources, not a copy in memory', async () => {
  const v = splitFmp4(fx.recVideo);
  const src = input([v.init, ...v.fragments]);
  const out = await remuxToMp4([src], {});
  const box = boxAt(new Uint8Array(await out.blob.slice(0, 16).arrayBuffer()), 0);
  assert.equal(box.type, 'ftyp');
  assert.ok(out.blob.size < src.blob.size, 'without the moof headers the output is smaller than the source');
});
