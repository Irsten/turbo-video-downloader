// MP4 without re-encoding: reading fragmented MP4 (fMP4/CMAF – HLS and DASH segments)
// and writing a regular MP4 file (ftyp + moov + mdat). Sample data is not copied into memory:
// the resulting Blob is made of slices of the working files.

const TWO32 = 2 ** 32;

// ---------------------------------------------------------------- reading

export const fourcc = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
export const u16 = (u8, p) => (u8[p] << 8) | u8[p + 1];
const u24 = (u8, p) => (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
export const u32 = (u8, p) => u8[p] * 0x1000000 + ((u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]);
const i32 = (u8, p) => (u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
const u64 = (u8, p) => u32(u8, p) * TWO32 + u32(u8, p + 4);

/** Header of the box starting at position p; null when it doesn't fit. */
export function boxAt(u8, p, end = u8.length) {
  if (p + 8 > end) return null;
  let size = u32(u8, p);
  const type = fourcc(u8, p + 4);
  let header = 8;
  if (size === 1) {
    if (p + 16 > end) return null;
    size = u64(u8, p + 8);
    header = 16;
  } else if (size === 0) size = end - p;
  if (size < header) return null;
  return { type, start: p, size, header, body: p + header, end: p + size };
}

export function* children(u8, start, end) {
  for (let p = start; p < end; ) {
    const b = boxAt(u8, p, end);
    if (!b) return;
    yield b;
    p = b.end;
  }
}

function child(u8, box, type) {
  if (!box) return null;
  for (const c of children(u8, box.body, Math.min(box.end, u8.length))) if (c.type === type) return c;
  return null;
}
const path = (u8, box, ...types) => types.reduce((b, t) => child(u8, b, t), box);

export const FMP4_TOP = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'sidx', 'emsg', 'prft', 'free', 'skip', 'mfra']);

/**
 * Tracks from the moov box (initialization segment). Returns { tracks: [...] } or null.
 * track: { id, handler, timescale, language, stsd (whole box), codec, width, height, defaults }
 */
export function parseInit(u8) {
  let moov = null;
  for (const b of children(u8, 0, u8.length)) if (b.type === 'moov') moov = b;
  if (!moov) return null;
  const trex = new Map();
  const mvex = child(u8, moov, 'mvex');
  if (mvex) {
    for (const b of children(u8, mvex.body, mvex.end)) {
      if (b.type !== 'trex') continue;
      const p = b.body + 4;
      trex.set(u32(u8, p), { duration: u32(u8, p + 8), size: u32(u8, p + 12), flags: u32(u8, p + 16) });
    }
  }
  const tracks = [];
  for (const trak of children(u8, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(u8, trak, 'tkhd');
    const mdhd = path(u8, trak, 'mdia', 'mdhd');
    const hdlr = path(u8, trak, 'mdia', 'hdlr');
    const stsd = path(u8, trak, 'mdia', 'minf', 'stbl', 'stsd');
    if (!tkhd || !mdhd || !hdlr || !stsd) continue;
    const tv = u8[tkhd.body];
    const mv = u8[mdhd.body];
    const entry = boxAt(u8, stsd.body + 8, stsd.end);
    const t = {
      id: u32(u8, tkhd.body + (tv ? 20 : 12)),
      handler: fourcc(u8, hdlr.body + 8),
      timescale: u32(u8, mdhd.body + (mv ? 20 : 12)),
      language: u16(u8, mdhd.body + (mv ? 32 : 20)),
      stsd: u8.slice(stsd.start, stsd.end),
      codec: entry?.type || '',
      width: 0,
      height: 0,
      defaults: null
    };
    t.defaults = trex.get(t.id) || { duration: 0, size: 0, flags: 0 };
    if (t.handler === 'vide' && entry) {
      t.width = u16(u8, entry.start + 32);
      t.height = u16(u8, entry.start + 34);
    }
    tracks.push(t);
  }
  return { tracks };
}

/**
 * Samples from a moof box. moofPos – position of the moof in the source file, mdatPos – start of the data
 * of the following mdat (when trun gives no offset), segStart – start of the segment (an explicit
 * base_data_offset counts from it). Returns sample runs with the position of their data.
 */
export function parseMoof(u8, moofPos, mdatPos, tracksById, segStart = 0) {
  const runs = [];
  const moof = boxAt(u8, 0);
  if (!moof || moof.type !== 'moof') return runs;
  for (const traf of children(u8, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue;
    let tf = null;
    let dts = null;
    let cursor = null;
    for (const b of children(u8, traf.body, traf.end)) {
      if (b.type === 'tfhd') {
        const flags = u24(u8, b.body + 1);
        let p = b.body + 4;
        const id = u32(u8, p);
        p += 4;
        const d = tracksById.get(id)?.defaults || { duration: 0, size: 0, flags: 0 };
        tf = { id, base: moofPos, duration: d.duration, size: d.size, flags: d.flags };
        if (flags & 0x01) (tf.base = segStart + u64(u8, p)), (p += 8);
        if (flags & 0x02) p += 4;
        if (flags & 0x08) (tf.duration = u32(u8, p)), (p += 4);
        if (flags & 0x10) (tf.size = u32(u8, p)), (p += 4);
        if (flags & 0x20) (tf.flags = u32(u8, p)), (p += 4);
      } else if (b.type === 'tfdt') {
        dts = u8[b.body] ? u64(u8, b.body + 4) : u32(u8, b.body + 4);
      } else if (b.type === 'trun' && tf) {
        const version = u8[b.body];
        const flags = u24(u8, b.body + 1);
        let p = b.body + 4;
        const count = u32(u8, p);
        p += 4;
        let dataPos = cursor ?? mdatPos ?? tf.base;
        if (flags & 0x01) (dataPos = tf.base + i32(u8, p)), (p += 4);
        let firstFlags = null;
        if (flags & 0x04) (firstFlags = u32(u8, p)), (p += 4);
        const run = {
          trackId: tf.id,
          dts,
          durations: new Uint32Array(count),
          sizes: new Uint32Array(count),
          ctos: new Int32Array(count),
          syncs: new Uint8Array(count),
          dataPos,
          bytes: 0
        };
        let total = 0;
        for (let i = 0; i < count; i++) {
          let dur = tf.duration;
          let size = tf.size;
          let sflags = tf.flags;
          let cto = 0;
          if (flags & 0x100) (dur = u32(u8, p)), (p += 4);
          if (flags & 0x200) (size = u32(u8, p)), (p += 4);
          if (flags & 0x400) (sflags = u32(u8, p)), (p += 4);
          if (flags & 0x800) (cto = version ? i32(u8, p) : u32(u8, p)), (p += 4);
          if (i === 0 && firstFlags !== null) sflags = firstFlags;
          run.durations[i] = dur;
          run.sizes[i] = size;
          run.ctos[i] = cto;
          run.syncs[i] = (sflags & 0x10000) === 0 ? 1 : 0; // sample_is_non_sync_sample
          run.bytes += size;
          total += dur;
        }
        runs.push(run);
        cursor = dataPos + run.bytes;
        if (dts !== null) dts += total;
      }
    }
  }
  return runs;
}

// ---------------------------------------------------------------- output track

class Grow {
  constructor(T) {
    this.a = new T(1024);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.a.constructor(this.n * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  get view() {
    return this.a.subarray(0, this.n);
  }
}

/** Track of the output file: sample table + where its data lives (runs in the source files). */
export class Mp4Track {
  /** info: { handler ('vide'|'soun'), timescale, language, stsd (Uint8Array), width, height } */
  constructor(info) {
    Object.assign(this, info);
    this.dts = new Grow(Float64Array);
    this.declared = new Grow(Uint32Array); // duration given by the source (0 = unknown)
    this.sizes = new Grow(Uint32Array);
    this.ctos = new Grow(Int32Array);
    this.syncs = new Grow(Uint8Array);
    this.runs = [];
    this.nextDts = null;
  }
  get count() {
    return this.sizes.n;
  }
  /**
   * A run of samples lying one after another in source (Blob) from offset.
   * Timing: dts (of the first one) + durations, or dtsList (one per sample).
   */
  addRun({ dts = null, dtsList = null, durations = null, sizes, ctos = null, syncs = null, source, offset }) {
    const n = sizes.length;
    if (!n) return;
    const first = this.count;
    let t = dts ?? this.nextDts ?? (dtsList ? dtsList[0] : 0);
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      const d = dtsList ? dtsList[i] : t;
      this.dts.push(d);
      this.declared.push(durations ? durations[i] : 0);
      this.sizes.push(sizes[i]);
      this.ctos.push(ctos ? ctos[i] : 0);
      this.syncs.push(syncs ? syncs[i] : 1);
      t = d + (durations ? durations[i] : 0);
      bytes += sizes[i];
    }
    this.nextDts = durations ? t : null;
    const last = this.runs[this.runs.length - 1];
    if (last && last.source === source && last.offset + last.size === offset && last.count < 1000) {
      last.size += bytes;
      last.count += n;
    } else {
      this.runs.push({ source, offset, size: bytes, first, count: n });
    }
  }

  /** Sample durations: from DTS differences (fills gaps and overlaps), and at discontinuities – from the declared ones. */
  durations() {
    const n = this.count;
    const dts = this.dts.view;
    const declared = this.declared.view;
    const out = new Uint32Array(n);
    const maxGap = this.timescale * 10;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      let d = i + 1 < n ? dts[i + 1] - dts[i] : 0;
      if (!(d > 0 && d <= maxGap)) d = declared[i] || prev || Math.round(this.timescale / 25);
      out[i] = Math.round(d);
      prev = out[i];
    }
    return out;
  }
}

// ---------------------------------------------------------------- writing

const enc4 = (s) => Uint8Array.of(s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3));

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function box(type, ...parts) {
  const body = concat(parts.flat());
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc4(type), 4);
  out.set(body, 8);
  return out;
}
export const fullBox = (type, version, flags, ...parts) =>
  box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

function nums(bits, values) {
  const out = new Uint8Array((values.length * bits) / 8);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => {
    if (bits === 8) dv.setUint8(i, v);
    else if (bits === 16) dv.setUint16(i * 2, v & 0xffff);
    else if (bits === 32) dv.setUint32(i * 4, v >>> 0);
    else {
      dv.setUint32(i * 8, Math.floor(v / TWO32));
      dv.setUint32(i * 8 + 4, v % TWO32);
    }
  });
  return out;
}
export const u8s = (...v) => nums(8, v);
export const u16s = (...v) => nums(16, v);
export const u32s = (...v) => nums(32, v);
const u64s = (...v) => nums(64, v);

const MATRIX = u32s(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
const WIDE = (v) => v > 0xffffffff;

/** Table of (count, value) pairs encoded as uint32 – for stts/ctts/stsc. */
function table(entries, width) {
  const out = new Uint8Array(entries.length * width * 4);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const e of entries) for (const v of e) dv.setUint32((o++) * 4, v >>> 0);
  return out;
}

function runLength(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const last = out[out.length - 1];
    if (last && last[1] === values[i]) last[0]++;
    else out.push([1, values[i]]);
  }
  return out;
}

function stbl(track, durations, chunkOffsets, wideOffsets) {
  const n = track.count;
  const ctos = track.ctos.view;
  const syncs = track.syncs.view;
  const stts = runLength(durations);
  const parts = [track.stsd, fullBox('stts', 0, 0, u32s(stts.length), table(stts, 2))];
  if (ctos.some((c) => c !== 0)) {
    const ctts = runLength(ctos);
    parts.push(fullBox('ctts', ctos.some((c) => c < 0) ? 1 : 0, 0, u32s(ctts.length), table(ctts, 2)));
  }
  if (track.handler === 'vide' && syncs.some((s) => !s)) {
    const keys = [];
    for (let i = 0; i < n; i++) if (syncs[i]) keys.push(i + 1);
    parts.push(fullBox('stss', 0, 0, u32s(keys.length), table(keys.map((k) => [k]), 1)));
  }
  const stsc = [];
  track.runs.forEach((r, i) => {
    if (!stsc.length || stsc[stsc.length - 1][1] !== r.count) stsc.push([i + 1, r.count, 1]);
  });
  parts.push(fullBox('stsc', 0, 0, u32s(stsc.length), table(stsc, 3)));
  const sizes = new Uint8Array(n * 4);
  const sdv = new DataView(sizes.buffer);
  track.sizes.view.forEach((s, i) => sdv.setUint32(i * 4, s));
  parts.push(fullBox('stsz', 0, 0, u32s(0, n), sizes));
  parts.push(
    wideOffsets
      ? fullBox('co64', 0, 0, u32s(chunkOffsets.length), u64s(...chunkOffsets))
      : fullBox('stco', 0, 0, u32s(chunkOffsets.length), u32s(...chunkOffsets))
  );
  return box('stbl', ...parts);
}

const HANDLER_NAME = { vide: 'VideoHandler', soun: 'SoundHandler' };

function trak(track, id, plan, chunkOffsets, wideOffsets) {
  const { durations, mediaDuration, mediaTime, delayMs, trackMs } = plan;
  const v1 = WIDE(mediaDuration) || WIDE(trackMs) ? 1 : 0;
  const isVideo = track.handler === 'vide';
  const tkhd = fullBox(
    'tkhd',
    v1,
    3,
    v1 ? u64s(0, 0) : u32s(0, 0),
    u32s(id, 0),
    v1 ? u64s(trackMs) : u32s(trackMs),
    u32s(0, 0),
    u16s(0, isVideo ? 0 : 1, isVideo ? 0 : 0x0100, 0),
    MATRIX,
    u32s(isVideo ? track.width * 0x10000 : 0, isVideo ? track.height * 0x10000 : 0)
  );
  const edits = [];
  if (delayMs > 0) edits.push([delayMs, -1]);
  edits.push([Math.max(0, trackMs - delayMs), mediaTime]);
  const edts = box(
    'edts',
    fullBox('elst', 0, 0, u32s(edits.length), ...edits.map(([dur, t]) => concat([u32s(dur, t), u16s(1, 0)])))
  );
  const mdhd = fullBox(
    'mdhd',
    v1,
    0,
    v1 ? u64s(0, 0) : u32s(0, 0),
    u32s(track.timescale),
    v1 ? u64s(mediaDuration) : u32s(mediaDuration),
    u16s(track.language || 0x55c4, 0)
  );
  const name = new TextEncoder().encode((HANDLER_NAME[track.handler] || 'Handler') + '\0');
  const hdlr = fullBox('hdlr', 0, 0, u32s(0), enc4(track.handler), u32s(0, 0, 0), name);
  const mhd = isVideo ? fullBox('vmhd', 0, 1, u16s(0, 0, 0, 0)) : fullBox('smhd', 0, 0, u16s(0, 0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32s(1), fullBox('url ', 0, 1)));
  const minf = box('minf', mhd, dinf, stbl(track, durations, chunkOffsets, wideOffsets));
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
}

/**
 * Builds a regular MP4 file from the given tracks. Returns { blob, duration (s), start (s) } –
 * start is the point on the source timeline where the output begins (for aligning subtitles).
 */
export function writeMp4(tracksIn) {
  const tracks = tracksIn.filter((t) => t.count > 0);
  if (!tracks.length) throw new Error('No samples to write');

  // Presentation start of every track (earliest PTS) and the common start.
  const starts = tracks.map((t) => {
    const dts = t.dts.view;
    const ctos = t.ctos.view;
    let min = Infinity;
    for (let i = 0; i < Math.min(t.count, 32); i++) min = Math.min(min, dts[i] + ctos[i]);
    return { pts: min, mediaTime: Math.max(0, Math.round(min - dts[0])) };
  });
  const start = Math.min(...starts.map((s, i) => s.pts / tracks[i].timescale));
  const plans = tracks.map((t, i) => {
    const durations = t.durations();
    const ctos = t.ctos.view;
    let mediaDuration = 0;
    for (const d of durations) mediaDuration += d;
    // Presentation end: latest PTS + duration (the last frames can be reordered).
    let presentedEnd = 0;
    for (let k = t.count - 1, dts = mediaDuration; k >= Math.max(0, t.count - 32); k--) {
      dts -= durations[k];
      presentedEnd = Math.max(presentedEnd, dts + ctos[k] + durations[k]);
    }
    const delayMs = Math.round((starts[i].pts / t.timescale - start) * 1000);
    const presentedMs = Math.round(((presentedEnd - starts[i].mediaTime) / t.timescale) * 1000);
    return { durations, mediaDuration, mediaTime: starts[i].mediaTime, delayMs, trackMs: delayMs + presentedMs };
  });
  const movieMs = Math.max(...plans.map((p) => p.trackMs));

  // Data order in mdat: runs of all tracks interleaved by time.
  const order = [];
  tracks.forEach((t, ti) => {
    const dts = t.dts.view;
    t.runs.forEach((r, ri) => order.push({ ti, ri, time: dts[r.first] / t.timescale, run: r }));
  });
  order.sort((a, b) => a.time - b.time || a.ti - b.ti);
  let dataSize = 0;
  for (const o of order) dataSize += o.run.size;

  const ftyp = box('ftyp', enc4('isom'), u32s(0x200), enc4('isom'), enc4('iso2'), enc4('avc1'), enc4('mp41'));
  const mdatHeader = dataSize + 8 > 0xffffffff ? concat([u32s(1), enc4('mdat'), u64s(dataSize + 16)]) : concat([u32s(dataSize + 8), enc4('mdat')]);

  const build = (wide, base) => {
    const offsets = tracks.map((t) => new Array(t.runs.length));
    let pos = base;
    for (const o of order) {
      offsets[o.ti][o.ri] = pos;
      pos += o.run.size;
    }
    const mvhd = fullBox(
      'mvhd',
      WIDE(movieMs) ? 1 : 0,
      0,
      WIDE(movieMs) ? u64s(0, 0) : u32s(0, 0),
      u32s(1000),
      WIDE(movieMs) ? u64s(movieMs) : u32s(movieMs),
      u32s(0x10000),
      u16s(0x100, 0),
      u32s(0, 0),
      MATRIX,
      u32s(0, 0, 0, 0, 0, 0),
      u32s(tracks.length + 1)
    );
    return box('moov', mvhd, ...tracks.map((t, i) => trak(t, i + 1, plans[i], offsets[i], wide)));
  };
  let moov = build(false, 0);
  let base = ftyp.length + moov.length + mdatHeader.length;
  const wide = base + dataSize > 0xffffffff;
  moov = build(wide, 0);
  base = ftyp.length + moov.length + mdatHeader.length;
  moov = build(wide, base);

  const parts = [ftyp, moov, mdatHeader];
  for (const o of order) parts.push(o.run.source.slice(o.run.offset, o.run.offset + o.run.size));
  return { blob: new Blob(parts, { type: 'video/mp4' }), duration: movieMs / 1000, start };
}
