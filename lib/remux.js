// Łączenie pobranych ścieżek (segmenty HLS/DASH, osobne audio) w jeden plik MP4 – bez ponownego
// kodowania, jak `ffmpeg -c copy`. Dane fMP4 zostają w plikach roboczych (wynik to ich wycinki),
// a dane z TS (po przepakowaniu H.264/AAC) trafiają do pliku tymczasowego `scratch`.
import { Mp4Track, parseInit, parseMoof, writeMp4, fourcc, u32, FMP4_TOP, box, fullBox, u8s, u16s, u32s } from './mp4.js';
import { TsDemuxer, parsePackedAudio, UnsupportedError } from './ts.js';

export { UnsupportedError };

const SCRATCH = Symbol('scratch');
const MAX_IN_MEMORY = 16 * 1024 * 1024;

const read = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

function concatAll(parts, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Rozpoznaje format po pierwszych bajtach. */
async function sniff(input) {
  const first = input.parts.find((p) => p[1] > 0);
  if (!first) return 'empty';
  const h = await read(input.blob, first[0], first[0] + Math.min(first[1], 1024));
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return 'packed';
  if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) return 'packed';
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return 'webm';
  if (h.length >= 8 && FMP4_TOP.has(fourcc(h, 4))) return 'fmp4';
  for (let i = 0; i < Math.min(188, h.length); i++) {
    if (h[i] === 0x47 && (i + 188 >= h.length || h[i + 188] === 0x47)) return 'ts';
  }
  return 'unknown';
}

// ---------------------------------------------------------------- opisy kodeków (stsd)

function descriptor(tag, ...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const head = len < 128 ? u8s(tag, len) : u8s(tag, 0x80 | (len >> 21), 0x80 | ((len >> 14) & 127), 0x80 | ((len >> 7) & 127), len & 127);
  return concatAll([head, ...parts], head.length + len);
}

function avcStsd({ sps, pps, width, height }) {
  const avcC = box('avcC', u8s(1, sps[1], sps[2], sps[3], 0xff, 0xe1), u16s(sps.length), sps, u8s(1), u16s(pps.length), pps);
  const avc1 = box(
    'avc1',
    new Uint8Array(6),
    u16s(1),
    new Uint8Array(16),
    u16s(width, height),
    u32s(0x480000, 0x480000, 0),
    u16s(1),
    new Uint8Array(32),
    u16s(0x18, 0xffff),
    avcC
  );
  return fullBox('stsd', 0, 0, u32s(1), avc1);
}

function aacStsd({ rate, channels, config }) {
  const es = descriptor(
    3,
    u16s(0),
    u8s(0),
    descriptor(4, u8s(0x40, 0x15, 0, 0, 0), u32s(0, 0), descriptor(5, config)),
    descriptor(6, u8s(2))
  );
  const mp4a = box(
    'mp4a',
    new Uint8Array(6),
    u16s(1),
    u32s(0, 0),
    u16s(channels, 16, 0, 0),
    u32s(rate > 0xffff ? 0 : rate * 0x10000),
    fullBox('esds', 0, 0, es)
  );
  return fullBox('stsd', 0, 0, u32s(1), mp4a);
}

// ---------------------------------------------------------------- dane przepakowane do scratch

/** Zbiera próbki ścieżki i co ~1 s dopisuje je jednym kawałkiem do pliku scratch. */
class Batch {
  constructor(track, scratch) {
    this.track = track;
    this.scratch = scratch;
    this.reset();
  }
  reset() {
    this.data = [];
    this.bytes = 0;
    this.dts = [];
    this.sizes = [];
    this.ctos = [];
    this.syncs = [];
  }
  add(data, dts, cto, sync) {
    this.data.push(data);
    this.bytes += data.length;
    this.dts.push(dts);
    this.sizes.push(data.length);
    this.ctos.push(cto);
    this.syncs.push(sync);
  }
  async maybeFlush() {
    const span = this.dts.length ? this.dts[this.dts.length - 1] - this.dts[0] : 0;
    if (span >= this.track.timescale || this.bytes >= 4 * 1024 * 1024) await this.flush();
  }
  async flush() {
    if (!this.sizes.length) return;
    const offset = await this.scratch.append(concatAll(this.data, this.bytes));
    this.track.addRun({
      dtsList: this.dts,
      sizes: this.sizes,
      ctos: this.ctos,
      syncs: this.syncs,
      source: SCRATCH,
      offset
    });
    this.reset();
  }
}

/** Klatka H.264: jednostki NAL z długością (AVCC) zamiast kodów startu. */
function avcc(nals) {
  let len = 0;
  for (const n of nals) len += 4 + n.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const n of nals) {
    dv.setUint32(o, n.length);
    out.set(n, o + 4);
    o += 4 + n.length;
  }
  return out;
}

async function fromTs(input, scratch, tick, signal) {
  const queue = [];
  const demux = new TsDemuxer((s) => queue.push(s));
  let video = null;
  let audio = null;
  let skipped = 0;
  const drain = async () => {
    for (const s of queue) {
      if (s.track === 'video') {
        if (!video) {
          // Dekoder potrzebuje zacząć od klatki kluczowej z parametrami (SPS/PPS).
          const ready = demux.video?.pps && (s.sync || ++skipped > 300);
          if (!ready) continue;
          const { width, height } = demux.video;
          video = new Batch(new Mp4Track({ handler: 'vide', timescale: 90000, stsd: avcStsd(demux.video), width, height }), scratch);
        }
        video.add(avcc(s.nals), s.dts, s.pts - s.dts, s.sync ? 1 : 0);
        await video.maybeFlush();
      } else {
        const a = demux.audio;
        if (!audio) audio = new Batch(new Mp4Track({ handler: 'soun', timescale: a.rate, stsd: aacStsd(a) }), scratch);
        audio.add(s.data, Math.round((s.pts * a.rate) / 90000), 0, 1);
        await audio.maybeFlush();
      }
    }
    queue.length = 0;
  };
  for (const [pos, size] of input.parts) {
    signal?.throwIfAborted();
    demux.push(await read(input.blob, pos, pos + size));
    await drain();
    tick();
  }
  demux.end();
  await drain();
  await video?.flush();
  await audio?.flush();
  return [video?.track, audio?.track].filter(Boolean);
}

async function fromPacked(input, scratch, tick, signal) {
  let batch = null;
  let next = null;
  for (const [pos, size] of input.parts) {
    signal?.throwIfAborted();
    const { pts, frames } = parsePackedAudio(await read(input.blob, pos, pos + size));
    if (frames.length) {
      const rate = frames[0].rate;
      batch ??= new Batch(new Mp4Track({ handler: 'soun', timescale: rate, stsd: aacStsd(frames[0]) }), scratch);
      let t = pts != null ? Math.round((pts * rate) / 90000) : next ?? 0;
      for (const f of frames) {
        batch.add(f.data, t, 0, 1);
        t += 1024;
      }
      next = t;
      await batch.maybeFlush();
    }
    tick();
  }
  await batch?.flush();
  return batch ? [batch.track] : [];
}

// ---------------------------------------------------------------- fMP4

/** Nagłówki pudełek najwyższego poziomu w zakresie [start, end) – z pamięci albo małymi odczytami. */
async function topBoxes(blob, start, end, buf) {
  const list = [];
  for (let p = start; p + 8 <= end; ) {
    const h = buf ? buf.subarray(p - start, p - start + 16) : await read(blob, p, Math.min(p + 16, end));
    let size = u32(h, 0);
    let header = 8;
    if (size === 1 && h.length >= 16) (size = u32(h, 8) * 2 ** 32 + u32(h, 12)), (header = 16);
    else if (size === 0) size = end - p;
    if (size < header) break;
    list.push({ type: fourcc(h, 4), start: p, end: Math.min(p + size, end), body: p + header });
    p += size;
  }
  return list;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function fromFmp4(input, tick, signal) {
  const info = new Map(); // id ścieżki -> opis z moov
  const out = new Map(); // id ścieżki -> Mp4Track
  for (const [pos, size] of input.parts) {
    signal?.throwIfAborted();
    const buf = size <= MAX_IN_MEMORY ? await read(input.blob, pos, pos + size) : null;
    const bytesOf = (b) => (buf ? buf.subarray(b.start - pos, b.end - pos) : read(input.blob, b.start, b.end));
    const list = await topBoxes(input.blob, pos, pos + size, buf);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.type === 'moov') {
        const init = parseInit(await bytesOf(b));
        for (const t of init?.tracks || []) {
          if (t.codec === 'encv' || t.codec === 'enca') throw new UnsupportedError('Ścieżka zaszyfrowana (DRM)');
          if (t.handler !== 'vide' && t.handler !== 'soun') continue;
          const known = info.get(t.id);
          if (known) {
            if (!sameBytes(known.stsd, t.stsd)) throw new UnsupportedError('Zmiana kodeka w trakcie strumienia');
            continue;
          }
          info.set(t.id, t);
          const { handler, timescale, language, stsd, width, height } = t;
          out.set(t.id, new Mp4Track({ handler, timescale, language, stsd, width, height }));
        }
      } else if (b.type === 'moof') {
        if (!info.size) throw new UnsupportedError('Brak segmentu inicjalizującego (moov)');
        const next = list[i + 1];
        const runs = parseMoof(await bytesOf(b), b.start, next?.type === 'mdat' ? next.body : null, info, pos);
        for (const r of runs) {
          out.get(r.trackId)?.addRun({
            dts: r.dts,
            durations: r.durations,
            sizes: r.sizes,
            ctos: r.ctos,
            syncs: r.syncs,
            source: input.blob,
            offset: r.dataPos
          });
        }
      }
    }
    tick();
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- całość

/**
 * inputs: [{ blob, parts: [[pozycja, rozmiar], ...] }] – kolejno wideo (albo całość) i osobne audio.
 * scratch: plik roboczy (DiskFile/MemoryFile) na dane przepakowane z TS.
 * Zwraca { blob, duration, start } albo rzuca UnsupportedError (wtedy zapisz pliki bez łączenia).
 */
export async function remuxToMp4(inputs, { scratch, signal, onProgress } = {}) {
  const total = inputs.reduce((n, i) => n + i.parts.length, 0) || 1;
  let done = 0;
  const tick = () => onProgress?.(++done / total);
  const tracks = [];
  let usedScratch = false;
  for (const input of inputs) {
    const kind = await sniff(input);
    if (kind === 'fmp4') tracks.push(...(await fromFmp4(input, tick, signal)));
    else if (kind === 'ts') {
      usedScratch = true;
      tracks.push(...(await fromTs(input, scratch, tick, signal)));
    } else if (kind === 'packed') {
      usedScratch = true;
      tracks.push(...(await fromPacked(input, scratch, tick, signal)));
    } else if (kind === 'webm') throw new UnsupportedError('Format WebM – łączenie w MP4 nieobsługiwane');
    else if (kind !== 'empty') throw new UnsupportedError('Nierozpoznany format segmentów');
  }
  if (!tracks.some((t) => t.count)) throw new UnsupportedError('Nie znaleziono ścieżek do połączenia');
  if (usedScratch) {
    const blob = await scratch.blob();
    for (const t of tracks) for (const r of t.runs) if (r.source === SCRATCH) r.source = blob;
  }
  return writeMp4(tracks);
}
