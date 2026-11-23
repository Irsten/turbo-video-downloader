// MPEG-TS (segmenty HLS) → próbki H.264 i AAC gotowe do zapisu w MP4, bez ponownego kodowania.
// Obsługiwane: wideo H.264, dźwięk AAC (ADTS) – w TS i jako osobne „packed audio” (ID3 + ADTS).
// Inne kodeki (H.265, AC-3, MP3…) zgłaszają UnsupportedError – wtedy zostaje zapis bez łączenia.

export class UnsupportedError extends Error {}

const TS = 188;
const TWO33 = 2 ** 33;
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const VIDEO_TYPES = { 0x1b: 'avc', 0x24: 'H.265', 0x02: 'MPEG-2', 0x10: 'MPEG-4' };
const AUDIO_TYPES = { 0x0f: 'aac', 0x03: 'MP3', 0x04: 'MP3', 0x11: 'AAC-LATM', 0x81: 'AC-3', 0x87: 'E-AC-3' };

function concat(a, b) {
  if (!a || !a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function readTs(b, p) {
  // 33-bitowy znacznik czasu z 5 bajtów nagłówka PES.
  return (b[p] & 0x0e) * 0x20000000 + ((b[p + 1] << 22) | ((b[p + 2] & 0xfe) << 14) | (b[p + 3] << 7) | (b[p + 4] >> 1));
}

/** Rozwija przepełnienie 33-bitowego zegara 90 kHz względem poprzedniej wartości. */
function unwrap(ts, ref) {
  if (ref == null) return ts;
  while (ts - ref > TWO33 / 2) ts -= TWO33;
  while (ref - ts > TWO33 / 2) ts += TWO33;
  return ts;
}

// ---------------------------------------------------------------- H.264

class Bits {
  constructor(u8) {
    this.u8 = u8;
    this.pos = 0;
  }
  bit() {
    const b = (this.u8[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue() {
    let z = 0;
    while (this.bit() === 0 && z < 32) z++;
    return 2 ** z - 1 + this.bits(z);
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

/** Usuwa bajty zapobiegające emulacji (00 00 03). */
function rbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

/** Rozdzielczość z SPS (z uwzględnieniem przycięcia). */
export function parseSps(nal) {
  const r = new Bits(rbsp(nal.subarray(1, Math.min(nal.length, 256))));
  const profile = r.bits(8);
  r.bits(16); // ograniczenia + poziom
  r.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue();
    r.ue();
    r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.bit()) continue;
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          if (next !== 0) last = next;
        }
      }
    }
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.bit();
    r.se();
    r.se();
    for (let i = r.ue(); i > 0; i--) r.se();
  }
  r.ue();
  r.bit();
  const wMbs = r.ue() + 1;
  const hMap = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit();
  let cl = 0;
  let cr = 0;
  let ct = 0;
  let cb = 0;
  if (r.bit()) {
    cl = r.ue();
    cr = r.ue();
    ct = r.ue();
    cb = r.ue();
  }
  const cx = chroma === 0 ? 1 : chroma === 3 ? 1 : 2;
  const cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    width: wMbs * 16 - (cl + cr) * cx,
    height: (2 - frameMbsOnly) * hMap * 16 - (ct + cb) * cy
  };
}

/** Jednostki NAL ze strumienia Annex B (kody startu 00 00 01 / 00 00 00 01). */
export function splitNals(u8) {
  const nals = [];
  let start = -1;
  for (let i = 0; i + 2 < u8.length; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && u8[end - 1] === 0) end--;
        if (end > start) nals.push(u8.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < u8.length) nals.push(u8.subarray(start));
  return nals;
}

// ---------------------------------------------------------------- AAC (ADTS)

/** Ramki ADTS z bufora. Zwraca { frames: [{data, rate, channels, config}], rest }. */
function readAdts(u8) {
  const frames = [];
  let p = 0;
  while (p + 7 <= u8.length) {
    if (u8[p] !== 0xff || (u8[p + 1] & 0xf6) !== 0xf0) {
      p++;
      continue;
    }
    const headerLen = u8[p + 1] & 1 ? 7 : 9;
    const len = ((u8[p + 3] & 3) << 11) | (u8[p + 4] << 3) | (u8[p + 5] >> 5);
    if (len < headerLen) {
      p++;
      continue;
    }
    if (p + len > u8.length) break;
    const profile = (u8[p + 2] >> 6) & 3;
    const rateIdx = (u8[p + 2] >> 2) & 0xf;
    const channels = ((u8[p + 2] & 1) << 2) | (u8[p + 3] >> 6);
    const objectType = profile + 1;
    frames.push({
      data: u8.subarray(p + headerLen, p + len),
      rate: AAC_RATES[rateIdx] || 44100,
      channels: channels || 2,
      config: Uint8Array.of((objectType << 3) | (rateIdx >> 1), ((rateIdx & 1) << 7) | ((channels || 2) << 3))
    });
    p += len;
  }
  return { frames, rest: u8.subarray(p) };
}

/** Znacznik czasu (90 kHz) z ramki PRIV com.apple.streaming.transportStreamTimestamp tagu ID3. */
function id3Timestamp(u8, p, end) {
  const owner = 'com.apple.streaming.transportStreamTimestamp';
  const v = u8[p + 3];
  let q = p + 10;
  while (q + 10 <= end) {
    const id = String.fromCharCode(u8[q], u8[q + 1], u8[q + 2], u8[q + 3]);
    const size =
      v >= 4
        ? (u8[q + 4] << 21) | (u8[q + 5] << 14) | (u8[q + 6] << 7) | u8[q + 7]
        : u8[q + 4] * 0x1000000 + ((u8[q + 5] << 16) | (u8[q + 6] << 8) | u8[q + 7]);
    if (!size || id.charCodeAt(0) === 0) break;
    if (id === 'PRIV') {
      const body = u8.subarray(q + 10, q + 10 + size);
      const zero = body.indexOf(0);
      if (zero > 0 && String.fromCharCode(...body.subarray(0, zero)) === owner && body.length >= zero + 9) {
        const t = body.subarray(zero + 1);
        return (t[3] & 1) * 2 ** 32 + ((t[4] << 24) >>> 0) + ((t[5] << 16) | (t[6] << 8) | t[7]);
      }
    }
    q += 10 + size;
  }
  return null;
}

/**
 * Segment „packed audio” (ID3 z czasem + ramki ADTS). Zwraca { pts (90 kHz lub null), frames }.
 */
export function parsePackedAudio(u8) {
  let p = 0;
  let pts = null;
  while (p + 10 <= u8.length && u8[p] === 0x49 && u8[p + 1] === 0x44 && u8[p + 2] === 0x33) {
    const size = (u8[p + 6] << 21) | (u8[p + 7] << 14) | (u8[p + 8] << 7) | u8[p + 9];
    pts ??= id3Timestamp(u8, p, p + 10 + size);
    p += 10 + size + (u8[p + 5] & 0x10 ? 10 : 0);
  }
  if (p < u8.length && u8[p] === 0xff && (u8[p + 1] & 0xf6) === 0xf0) return { pts, frames: readAdts(u8.subarray(p)).frames };
  throw new UnsupportedError('Ścieżka audio w formacie innym niż AAC');
}

// ---------------------------------------------------------------- demultiplekser TS

/**
 * Przyjmuje kolejne kawałki strumienia TS (push) i oddaje próbki przez onSample:
 *   wideo: { track: 'video', dts, pts, sync, nals: [Uint8Array] }   (czas w 90 kHz)
 *   audio: { track: 'audio', pts, data, rate, channels, config }
 * Po zakończeniu: end(). Parametry ścieżek: this.video { sps, pps, width, height }, this.audio.
 */
export class TsDemuxer {
  constructor(onSample) {
    this.onSample = onSample;
    this.rest = null;
    this.pmtPid = -1;
    this.videoPid = -1;
    this.audioPid = -1;
    this.pes = new Map(); // pid -> [Uint8Array]
    this.video = null;
    this.audio = null;
    this.pendingVideo = null;
    this.audioRest = null;
    this.audioNext = null;
    this.lastVideo = null;
    this.lastAudio = null;
  }

  push(chunk) {
    const u8 = this.rest ? concat(this.rest, chunk) : chunk;
    let p = 0;
    while (p + TS <= u8.length) {
      if (u8[p] !== 0x47) {
        p++; // zgubiona synchronizacja – szukaj następnego pakietu
        continue;
      }
      this.packet(u8, p);
      p += TS;
    }
    this.rest = p < u8.length ? u8.slice(p) : null;
  }

  packet(u8, p) {
    const pusi = u8[p + 1] & 0x40;
    const pid = ((u8[p + 1] & 0x1f) << 8) | u8[p + 2];
    const afc = (u8[p + 3] >> 4) & 3;
    let q = p + 4;
    if (afc & 2) q += 1 + u8[q];
    if (!(afc & 1) || q >= p + TS) return;
    const payload = u8.subarray(q, p + TS);
    if (pid === 0) {
      if (pusi) this.pat(payload);
    } else if (pid === this.pmtPid) {
      if (pusi) this.pmt(payload);
    } else if (pid === this.videoPid || pid === this.audioPid) {
      if (pusi) this.flushPes(pid);
      if (!this.pes.has(pid)) {
        if (!pusi) return; // środek PES bez początku – pomiń
        this.pes.set(pid, []);
      }
      this.pes.get(pid).push(payload.slice());
    }
  }

  pat(payload) {
    const t = payload.subarray(1 + payload[0]);
    const len = ((t[1] & 0x0f) << 8) | t[2];
    for (let i = 8; i + 4 <= Math.min(3 + len - 4, t.length); i += 4) {
      const program = (t[i] << 8) | t[i + 1];
      if (program !== 0) {
        this.pmtPid = ((t[i + 2] & 0x1f) << 8) | t[i + 3];
        return;
      }
    }
  }

  pmt(payload) {
    const t = payload.subarray(1 + payload[0]);
    const len = ((t[1] & 0x0f) << 8) | t[2];
    const end = Math.min(3 + len - 4, t.length);
    let i = 12 + (((t[10] & 0x0f) << 8) | t[11]);
    let unsupportedVideo = null;
    let unsupportedAudio = null;
    let video = -1;
    let audio = -1;
    while (i + 5 <= end) {
      const type = t[i];
      const pid = ((t[i + 1] & 0x1f) << 8) | t[i + 2];
      const infoLen = ((t[i + 3] & 0x0f) << 8) | t[i + 4];
      let ac3 = false;
      for (let d = i + 5; d + 2 <= i + 5 + infoLen; d += 2 + t[d + 1]) if (t[d] === 0x6a || t[d] === 0x7a) ac3 = true;
      if (type === 0x1b) video = video < 0 ? pid : video;
      else if (type === 0x0f) audio = audio < 0 ? pid : audio;
      else if (VIDEO_TYPES[type]) unsupportedVideo = VIDEO_TYPES[type];
      else if (AUDIO_TYPES[type]) unsupportedAudio = AUDIO_TYPES[type];
      else if (type === 0x06 && ac3) unsupportedAudio = 'AC-3';
      i += 5 + infoLen;
    }
    if (video < 0 && unsupportedVideo) throw new UnsupportedError(`Kodek wideo ${unsupportedVideo} – łączenie w MP4 nieobsługiwane`);
    if (audio < 0 && unsupportedAudio) throw new UnsupportedError(`Kodek audio ${unsupportedAudio} – łączenie w MP4 nieobsługiwane`);
    this.videoPid = video;
    this.audioPid = audio;
  }

  flushPes(pid) {
    const parts = this.pes.get(pid);
    this.pes.delete(pid);
    if (!parts || !parts.length) return;
    let len = 0;
    for (const x of parts) len += x.length;
    const d = new Uint8Array(len);
    let o = 0;
    for (const x of parts) {
      d.set(x, o);
      o += x.length;
    }
    if (d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
    const flags = d[7];
    let pts;
    let dts;
    if (flags & 0x80) pts = readTs(d, 9);
    if ((flags & 0xc0) === 0xc0) dts = readTs(d, 14);
    const payload = d.subarray(9 + d[8]);
    if (pid === this.videoPid) this.videoPes(pts, dts, payload);
    else this.audioPes(pts, payload);
  }

  videoPes(pts, dts, payload) {
    const nals = splitNals(payload);
    if (pts === undefined) {
      // Dalszy ciąg tej samej klatki w kolejnym PES.
      this.pendingVideo?.nals.push(...nals);
      return;
    }
    this.emitVideo();
    pts = unwrap(pts, this.lastVideo);
    dts = dts === undefined ? pts : unwrap(dts, pts);
    this.lastVideo = dts;
    this.pendingVideo = { pts, dts, nals };
  }

  emitVideo() {
    const v = this.pendingVideo;
    this.pendingVideo = null;
    if (!v) return;
    let sync = false;
    const nals = [];
    for (const nal of v.nals) {
      const type = nal[0] & 0x1f;
      if (type === 9) continue; // AUD
      if (type === 7 && !this.video) {
        try {
          this.video = { sps: nal.slice(), pps: null, ...parseSps(nal) };
        } catch {
          continue;
        }
      }
      if (type === 8 && this.video && !this.video.pps) this.video.pps = nal.slice();
      if (type === 5) sync = true;
      nals.push(nal);
    }
    if (!nals.length) return;
    this.onSample({ track: 'video', pts: v.pts, dts: v.dts, sync, nals });
  }

  audioPes(pts, payload) {
    const data = this.audioRest ? concat(this.audioRest, payload) : payload;
    const carried = this.audioRest?.length > 0;
    const { frames, rest } = readAdts(data);
    this.audioRest = rest.length ? rest.slice() : null;
    if (!frames.length) return;
    if (!this.audio) this.audio = { rate: frames[0].rate, channels: frames[0].channels, config: frames[0].config };
    const step = (1024 * 90000) / this.audio.rate;
    let t = carried && this.audioNext != null ? this.audioNext : pts !== undefined ? unwrap(pts, this.lastAudio) : this.audioNext;
    if (t == null) return; // brak czasu – nie da się umieścić na osi
    for (const f of frames) {
      this.onSample({ track: 'audio', pts: t, data: f.data });
      t += step;
    }
    this.lastAudio = t;
    this.audioNext = t;
  }

  end() {
    for (const pid of [...this.pes.keys()]) this.flushPes(pid);
    this.emitVideo();
  }
}
