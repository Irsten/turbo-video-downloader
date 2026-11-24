// Test material from the recordings in tests/fixtures: TS segments (a simple muxer), packed AAC, fMP4
// cut into fragments, HLS playlists, DASH manifests and WebVTT subtitles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const TS_OFFSET = 10; // s – TS and subtitles start at PTS 10 s, as in real streams

export function loadFixtures() {
  const load = (name) => {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(DIR, name + (name === 'video' ? '.h264' : '.adts')));
    let o = 0;
    return meta.map((m) => {
      const data = buf.subarray(o, o + m.size);
      o += m.size;
      return { key: !!m.key, pts: m.pts / 1e6, data };
    });
  };
  return {
    video: load('video'),
    audio: load('audio'),
    recVideo: fs.readFileSync(path.join(DIR, 'rec-video.mp4')),
    recAudio: fs.readFileSync(path.join(DIR, 'rec-audio.mp4'))
  };
}

// ---------------------------------------------------------------- MPEG-TS

const PMT_PID = 0x1000;
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

function section(bytes) {
  const crc = crc32(bytes);
  return [...bytes, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255];
}

function psiPacket(pid, sec, cc) {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x10 | (cc & 15), 0, ...sec]);
  return pkt;
}

const ptsBytes = (prefix, ts) => [
  (prefix << 4) | ((Math.floor(ts / 2 ** 30) & 7) << 1) | 1,
  Math.floor(ts / 2 ** 22) & 255,
  ((Math.floor(ts / 2 ** 15) & 127) << 1) | 1,
  Math.floor(ts / 2 ** 7) & 255,
  ((ts % 128) << 1) | 1
];

function pcrBytes(base) {
  return [
    Math.floor(base / 2 ** 25) & 255,
    Math.floor(base / 2 ** 17) & 255,
    Math.floor(base / 2 ** 9) & 255,
    Math.floor(base / 2) & 255,
    ((base % 2) << 7) | 0x7e,
    0
  ];
}

function pesPackets(pid, pes, ccRef, pcr) {
  const out = [];
  let p = 0;
  let first = true;
  while (p < pes.length) {
    const pkt = new Uint8Array(188);
    pkt[0] = 0x47;
    pkt[1] = (first ? 0x40 : 0) | (pid >> 8);
    pkt[2] = pid & 255;
    const withPcr = first && pcr != null;
    let af = withPcr ? 8 : 0; // length of the adaptation field including its length byte
    if (184 - af > pes.length - p) af = 184 - (pes.length - p);
    pkt[3] = (af ? 0x30 : 0x10) | (ccRef.cc++ & 15);
    let q = 4;
    if (af) {
      pkt[q] = af - 1;
      if (af >= 2) {
        pkt[q + 1] = withPcr ? 0x10 : 0;
        let s = q + 2;
        if (withPcr) {
          pkt.set(pcrBytes(pcr), s);
          s += 6;
        }
        pkt.fill(0xff, s, q + af);
      }
      q += af;
    }
    const take = 188 - q;
    pkt.set(pes.subarray(p, p + take), q);
    p += take;
    first = false;
    out.push(pkt);
  }
  return out;
}

/**
 * A TS segment from video frames and audio frames with times in [from, to).
 * cto – PTS delay relative to DTS in frames (simulates B-frames → ctts and an edit list).
 * shift – time offset (s), e.g. so that consecutive "live segments" have a continuous PTS timeline.
 */
export function buildTs(fx, from, to, { video = true, audio = true, cto = 0, shift = 0, cc = { v: { cc: 0 }, a: { cc: 0 }, psi: 0 } } = {}) {
  const OFFSET = TS_OFFSET + shift;
  const pmt = [0x02, 0xb0, 0, 0x00, 0x01, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 255, 0xf0, 0];
  if (video) pmt.push(0x1b, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 255, 0xf0, 0);
  if (audio) pmt.push(0x0f, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 255, 0xf0, 0);
  pmt[2] = pmt.length - 3 + 4;
  const pat = [0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PMT_PID >> 8), PMT_PID & 255];
  const packets = [psiPacket(0, section(pat), cc.psi), psiPacket(PMT_PID, section(pmt), cc.psi)];
  cc.psi++;

  const events = [];
  if (video) {
    for (const f of fx.video) {
      if (f.pts < from || f.pts >= to) continue;
      const dts = Math.round((OFFSET + f.pts) * 90000);
      const pts = dts + cto * 3600;
      const head = [0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10, ...ptsBytes(3, pts), ...ptsBytes(1, dts)];
      const pes = new Uint8Array(head.length + f.data.length);
      pes.set(head);
      pes.set(f.data, head.length);
      events.push({ t: dts, pid: VIDEO_PID, pes, pcr: dts - 9000 });
    }
  }
  if (audio) {
    const frames = fx.audio.filter((f) => f.pts >= from && f.pts < to);
    for (let i = 0; i < frames.length; i += 4) {
      const group = frames.slice(i, i + 4);
      const pts = Math.round((OFFSET + group[0].pts) * 90000);
      const data = Buffer.concat(group.map((g) => g.data));
      const head = [0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, ...ptsBytes(2, pts)];
      const len = head.length - 6 + data.length;
      head[4] = len >> 8;
      head[5] = len & 255;
      const pes = new Uint8Array(head.length + data.length);
      pes.set(head);
      pes.set(data, head.length);
      events.push({ t: pts, pid: AUDIO_PID, pes });
    }
  }
  events.sort((a, b) => a.t - b.t);
  for (const e of events) packets.push(...pesPackets(e.pid, e.pes, e.pid === VIDEO_PID ? cc.v : cc.a, e.pcr));
  return Buffer.concat(packets);
}

/** A "packed audio" segment: ID3 tag with the timestamp (PRIV) + ADTS frames. */
export function buildPackedAac(fx, from, to) {
  const frames = fx.audio.filter((f) => f.pts >= from && f.pts < to);
  const pts = Math.round((TS_OFFSET + frames[0].pts) * 90000);
  const owner = Buffer.from('com.apple.streaming.transportStreamTimestamp\0', 'latin1');
  const ts = Buffer.alloc(8);
  ts.writeUInt32BE(Math.floor(pts / 2 ** 32), 0);
  ts.writeUInt32BE(pts % 2 ** 32, 4);
  const body = Buffer.concat([owner, ts]);
  const syncsafe = (n) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
  const frame = Buffer.from([...Buffer.from('PRIV'), ...syncsafe(body.length), 0, 0, ...body]);
  const tag = Buffer.from([...Buffer.from('ID3'), 4, 0, 0, ...syncsafe(frame.length), ...frame]);
  return Buffer.concat([tag, ...frames.map((f) => f.data)]);
}

// ---------------------------------------------------------------- fMP4

function boxes(buf) {
  const list = [];
  for (let p = 0; p + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(p);
    list.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, end: p + size });
    p += size;
  }
  return list;
}

/** Fragmented file → { init (ftyp+moov), fragments: [moof+mdat], durations (s) }. */
export function splitFmp4(buf) {
  const list = boxes(buf);
  const moov = list.find((b) => b.type === 'moov');
  const init = buf.subarray(0, moov.end);
  const timescale = readMdhdTimescale(buf.subarray(moov.start, moov.end));
  const fragments = [];
  const times = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].type !== 'moof') continue;
    const end = list[i + 1]?.type === 'mdat' ? list[i + 1].end : list[i].end;
    const frag = buf.subarray(list[i].start, end);
    fragments.push(frag);
    times.push(readTfdt(frag));
  }
  const total = sumDurations(buf.subarray(list.find((b) => b.type === 'moof').start), timescale);
  const durations = times.map((t, i) => ((i + 1 < times.length ? times[i + 1] : times[0] + total) - t) / timescale);
  return { init, fragments, durations, timescale, times };
}

function readMdhdTimescale(moov) {
  const p = moov.indexOf('mdhd', 0, 'latin1');
  return moov[p + 4] ? moov.readUInt32BE(p + 24) : moov.readUInt32BE(p + 16);
}
function readTfdt(frag) {
  const p = frag.indexOf('tfdt', 0, 'latin1');
  return frag[p + 4] ? Number(frag.readBigUInt64BE(p + 8)) : frag.readUInt32BE(p + 8);
}
/** Total duration of samples from all trun boxes (for the length of the last fragment). */
function sumDurations(buf, timescale) {
  let total = 0;
  let p = 0;
  while ((p = buf.indexOf('trun', p, 'latin1')) >= 0) {
    const flags = buf.readUIntBE(p + 5, 3);
    const count = buf.readUInt32BE(p + 8);
    const q = p + 12 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
    const per = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length * 4;
    if (flags & 0x100) for (let i = 0; i < count; i++) total += buf.readUInt32BE(q + i * per);
    else total += count * (timescale / 30);
    p += 4;
  }
  return total;
}

// ---------------------------------------------------------------- HLS / DASH / WebVTT

export function mediaPlaylist(segments, { map, endList = true, seq = 0, extra = '' } = {}) {
  const target = Math.ceil(Math.max(...segments.map((s) => s.dur), 1));
  let s = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${seq}\n${extra}`;
  if (map) s += `#EXT-X-MAP:URI="${map}"\n`;
  for (const seg of segments) s += `#EXTINF:${seg.dur.toFixed(3)},\n${seg.uri}\n`;
  return s + (endList ? '#EXT-X-ENDLIST\n' : '');
}

const vttTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

export const CUES = [
  { start: 0.5, end: 1.9, text: 'Good morning' },
  { start: 2.5, end: 4.5, text: 'Italic <i>text</i> &amp; more' }, // crosses a segment boundary
  { start: 6.2, end: 7.8, text: 'First line\nSecond line' }
];

/** WebVTT segments of 2 s with X-TIMESTAMP-MAP (subtitle time 0 = PTS of the recording start). */
export function vttSegments(cues = CUES, segLen = 2, total = 8) {
  const out = [];
  for (let s = 0; s < total; s += segLen) {
    let v = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${TS_OFFSET * 90000},LOCAL:00:00:00.000\n\n`;
    for (const c of cues) if (c.start < s + segLen && c.end > s) v += `${vttTime(c.start)} --> ${vttTime(c.end)} align:center\n${c.text}\n\n`;
    out.push(v);
  }
  return out;
}

export function vttFile(cues = CUES) {
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n');
}
