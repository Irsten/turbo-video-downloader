// Silnik pobierania: wiele równoległych połączeń (HTTP Range) z dzieleniem
// wolnych fragmentów w locie, wznawianiem po zerwaniu i równoległym HLS.
// Działa w stronie rozszerzenia i w Node 18+ (testy) – używa tylko fetch/Blob.
import { parseM3U8, pickVariant } from './hls.js';

const MiB = 1024 * 1024;
const SPLIT_MIN_REMAINING = 4 * MiB; // dziel aktywny fragment, gdy zostało mu >= 4 MiB
export const ENCRYPTED_MSG =
  'Ten strumień jest zaszyfrowany (DRM / klucz AES). Takich treści rozszerzenie nie pobiera.';

export class HttpError extends Error {
  constructor(status, url) {
    super(`Serwer odpowiedział HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

const retriableStatus = (s) => s === 408 || s === 425 || s === 429 || s >= 500;
const backoff = (attempt) => Math.min(8000, 400 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Anulowano', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Łączy sygnał zewnętrzny z wewnętrznym (żeby błąd jednego wątku zatrzymał resztę). */
function linkedController(signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl;
}

/** Zbiera kawałki strumienia i co kilka MB zamienia je w Blob (zdejmuje dane ze sterty JS). */
class Collector {
  constructor(flushAt = 4 * MiB) {
    this.pieces = [];
    this.buf = [];
    this.bufBytes = 0;
    this.flushAt = flushAt;
  }
  push(u8) {
    this.buf.push(u8);
    this.bufBytes += u8.byteLength;
    if (this.bufBytes >= this.flushAt) this.flush();
  }
  flush() {
    if (this.buf.length) {
      this.pieces.push(new Blob(this.buf));
      this.buf = [];
      this.bufBytes = 0;
    }
  }
  parts() {
    this.flush();
    return this.pieces;
  }
}

function withHeaders(init, extra) {
  return { ...init, headers: { ...(init.headers || {}), ...extra } };
}

/** fetch z ponawianiem przy błędach sieci i statusach 5xx/429. */
async function fetchRetry(url, init, { retries, signal, ok = (r) => r.ok }) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (ok(res)) return res;
      res.body?.cancel().catch(() => {});
      throw new HttpError(res.status, url);
    } catch (e) {
      if (signal?.aborted) throw abortReason(signal);
      if (e instanceof HttpError && !retriableStatus(e.status)) throw e;
      if (attempt > retries) throw e;
      await sleep(backoff(attempt), signal);
    }
  }
}

/**
 * Pobiera pojedynczy plik. Jeśli serwer obsługuje Range – na wielu połączeniach.
 * @returns {Promise<{blob: Blob, size: number, contentType: string, ranged: boolean, connectionsUsed: number}>}
 */
export async function downloadFile(url, opts = {}) {
  const {
    connections = 6,
    signal: outerSignal,
    onProgress,
    prepare,
    fetchInit = {},
    retries = 6,
    minChunk = 2 * MiB,
    maxChunk = 32 * MiB
  } = opts;

  await prepare?.(url);
  const ctrl = linkedController(outerSignal);
  const signal = ctrl.signal;
  let loaded = 0;
  let total = null;
  const report = (n) => {
    loaded += n;
    onProgress?.({ loaded, total });
  };

  // Sonda: 1 bajt z zakresem. 206 => są zakresy i znamy rozmiar. 200 => serwer ignoruje Range,
  // wtedy po prostu czytamy tę odpowiedź jako całość (bez straty żądania).
  let probe;
  try {
    probe = await fetchRetry(url, withHeaders(fetchInit, { Range: 'bytes=0-0' }), {
      retries,
      signal,
      ok: (r) => r.status === 200 || r.status === 206
    });
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 416)) throw e;
    probe = null; // serwer nie lubi zakresu 0-0 – pobierz normalnie
  }
  const contentType = probe?.headers.get('content-type') || '';
  const finalUrl = probe?.url || url;
  if (!probe) return singleDownload(null);

  if (probe.status === 206) {
    const m = /\/(\d+)\s*$/.exec(probe.headers.get('content-range') || '');
    probe.body?.cancel().catch(() => {});
    if (m && Number(m[1]) > 0) {
      total = Number(m[1]);
      onProgress?.({ loaded, total });
      return rangedDownload();
    }
    return singleDownload(null);
  }
  return singleDownload(probe);

  // ---------- jedno połączenie ----------
  async function singleDownload(res) {
    for (let attempt = 1; ; attempt++) {
      let got = 0;
      try {
        if (!res) res = await fetchRetry(finalUrl, fetchInit, { retries, signal });
        const len = Number(res.headers.get('content-length')) || null;
        const encoded = !!res.headers.get('content-encoding');
        total = encoded ? null : len;
        const col = new Collector();
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            col.push(value);
            got += value.byteLength;
            report(value.byteLength);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        if (total && got < total) throw new Error('Połączenie zerwane przed końcem pliku');
        total = got;
        onProgress?.({ loaded, total });
        const ct = res.headers.get('content-type') || contentType;
        return {
          blob: new Blob(col.parts(), { type: ct }),
          size: got,
          contentType: ct,
          ranged: false,
          connectionsUsed: 1
        };
      } catch (e) {
        if (signal.aborted) throw abortReason(signal);
        if (e instanceof HttpError && !retriableStatus(e.status)) throw e;
        if (attempt > 3) throw e;
        report(-got);
        res = null;
        await sleep(backoff(attempt), signal);
      }
    }
  }

  // ---------- wiele połączeń ----------
  async function rangedDownload() {
    const chunkSize = Math.max(minChunk, Math.min(maxChunk, Math.ceil(total / (connections * 4))));
    const all = [];
    for (let s = 0; s < total; s += chunkSize) {
      all.push({ start: s, end: Math.min(s + chunkSize, total) - 1, received: 0, col: new Collector() });
    }
    const queue = [...all];
    const active = new Set();

    // Gdy kolejka pusta: przejmij drugą połowę najwolniejszego (najdłuższego) aktywnego fragmentu.
    const takeWork = () => {
      if (queue.length) return queue.shift();
      let best = null;
      let bestRem = 0;
      for (const c of active) {
        const rem = c.end - (c.start + c.received) + 1;
        if (rem > bestRem) (best = c), (bestRem = rem);
      }
      if (!best || bestRem < SPLIT_MIN_REMAINING) return null;
      const mid = best.start + best.received + Math.floor(bestRem / 2);
      const nc = { start: mid, end: best.end, received: 0, col: new Collector() };
      best.end = mid - 1;
      all.push(nc);
      return nc;
    };

    const fetchChunk = async (c) => {
      let attempt = 0;
      for (;;) {
        const from = c.start + c.received;
        if (from > c.end) return;
        try {
          const res = await fetch(finalUrl, { ...withHeaders(fetchInit, { Range: `bytes=${from}-${c.end}` }), signal });
          if (res.status !== 206) {
            res.body?.cancel().catch(() => {});
            if (res.status === 200) throw new Error('Serwer przestał obsługiwać pobieranie zakresami');
            throw new HttpError(res.status, finalUrl);
          }
          const reader = res.body.getReader();
          try {
            for (;;) {
              if (c.start + c.received > c.end) break;
              const { done, value } = await reader.read();
              if (done) break;
              const need = c.end - (c.start + c.received) + 1; // koniec mógł się przesunąć (podział)
              if (need <= 0) break;
              const part = value.byteLength > need ? value.subarray(0, need) : value;
              c.col.push(part);
              c.received += part.byteLength;
              report(part.byteLength);
              attempt = 0; // są postępy – licznik prób od nowa
            }
          } finally {
            reader.cancel().catch(() => {});
          }
          if (c.start + c.received > c.end) return;
          throw new Error('Połączenie zerwane w trakcie fragmentu');
        } catch (e) {
          if (signal.aborted) throw abortReason(signal);
          if (e instanceof HttpError && !retriableStatus(e.status) && e.status !== 403) throw e;
          if (++attempt > retries) throw e;
          await sleep(backoff(attempt), signal); // wznowienie od ostatniego bajtu
        }
      }
    };

    const worker = async () => {
      let c;
      while ((c = takeWork())) {
        active.add(c);
        try {
          await fetchChunk(c);
        } finally {
          active.delete(c);
        }
      }
    };

    const n = Math.max(1, Math.min(connections, all.length));
    try {
      await Promise.all(Array.from({ length: n }, () => worker().catch((e) => (ctrl.abort(e), Promise.reject(e)))));
    } catch (e) {
      ctrl.abort(e);
      throw outerSignal?.aborted ? abortReason(outerSignal) : e;
    }

    all.sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const c of all) {
      if (c.start !== pos || c.received !== c.end - c.start + 1) throw new Error('Błąd składania pliku z fragmentów');
      pos = c.end + 1;
    }
    if (pos !== total) throw new Error('Rozmiar złożonego pliku się nie zgadza');

    return {
      blob: new Blob(all.flatMap((c) => c.col.parts()), { type: contentType }),
      size: total,
      contentType,
      ranged: true,
      connectionsUsed: n
    };
  }
}

// =====================================================================
// HLS
// =====================================================================

export async function fetchPlaylist(url, { fetchInit = {}, signal, retries = 4, prepare } = {}) {
  await prepare?.(url);
  const res = await fetchRetry(url, fetchInit, { retries, signal });
  const text = await res.text();
  return parseM3U8(text, res.url || url);
}

function containerExt(pl, isAudio) {
  const first = pl.segments[0]?.url || '';
  const path = (() => {
    try {
      return new URL(first).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (pl.segments.some((s) => s.map) || /\.(m4s|mp4|m4v|m4a|cmf[va])$/.test(path)) return isAudio ? 'm4a' : 'mp4';
  if (/\.aac$/.test(path)) return 'aac';
  if (/\.mp3$/.test(path)) return 'mp3';
  return 'ts';
}

/**
 * Pobiera listę segmentów równolegle i skleja w kolejności.
 * onBytes(n) – przyrost bajtów, onSegment() – ukończony segment.
 */
async function downloadSegments(pl, { concurrency, signal, fetchInit, retries, prepare, onBytes, onSegment }) {
  // Lista do pobrania: segmenty + sekcje inicjalizujące (EXT-X-MAP) tam, gdzie się zmieniają.
  const items = [];
  let lastMap = null;
  for (const s of pl.segments) {
    if (s.map && (!lastMap || s.map.url !== lastMap.url || String(s.map.range) !== String(lastMap.range))) {
      items.push(s.map);
      lastMap = s.map;
    }
    items.push(s);
  }

  const prepared = new Set();
  for (const it of items) {
    const host = new URL(it.url).host;
    if (!prepared.has(host)) {
      prepared.add(host);
      await prepare?.(it.url);
    }
  }

  const results = new Array(items.length);
  let next = 0;

  const fetchItem = async (it) => {
    const init = it.range ? withHeaders(fetchInit, { Range: `bytes=${it.range[0]}-${it.range[1]}` }) : fetchInit;
    for (let attempt = 1; ; attempt++) {
      let got = 0;
      try {
        const res = await fetch(it.url, { ...init, signal });
        if (!res.ok) {
          res.body?.cancel().catch(() => {});
          throw new HttpError(res.status, it.url);
        }
        const col = new Collector(64 * MiB);
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            col.push(value);
            got += value.byteLength;
            onBytes(value.byteLength);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        const len = Number(res.headers.get('content-length'));
        if (len && !res.headers.get('content-encoding') && got < len) throw new Error('Segment niepełny');
        let blob = new Blob(col.parts());
        // Serwer zignorował Range przy BYTERANGE – wytnij właściwy kawałek.
        if (it.range && res.status === 200) blob = blob.slice(it.range[0], it.range[1] + 1);
        return blob;
      } catch (e) {
        if (signal.aborted) throw abortReason(signal);
        onBytes(-got);
        if (e instanceof HttpError && !retriableStatus(e.status) && e.status !== 403) throw e;
        if (attempt > retries) throw e;
        await sleep(backoff(attempt), signal);
      }
    }
  };

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fetchItem(items[i]);
      onSegment();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { blob: new Blob(results), count: items.length };
}

/**
 * Pobiera strumień HLS. Dla playlisty master wybiera wariant (variantUrl albo najlepszy).
 * Jeśli dźwięk jest w osobnej ścieżce, pobiera ją jako drugi plik.
 * onProgress({ loaded, total (szacunek), segmentsDone, segmentsTotal })
 */
export async function downloadHls(url, opts = {}) {
  const { variantUrl, concurrency = 8, signal: outerSignal, onProgress, onInfo, prepare, fetchInit = {}, retries = 6 } =
    opts;
  const ctrl = linkedController(outerSignal);
  const signal = ctrl.signal;
  const common = { fetchInit, signal, retries, prepare };

  let pl = await fetchPlaylist(url, common);
  let variant = null;
  let audioPl = null;
  let audioTrack = null;

  if (pl.kind === 'master') {
    if (pl.encrypted) throw new Error(ENCRYPTED_MSG);
    if (!pl.variants.length) throw new Error('Playlista nie zawiera żadnych wariantów');
    variant = pickVariant(pl, variantUrl);
    if (variant.audio) {
      const group = pl.audios.filter((a) => a.groupId === variant.audio && a.url);
      audioTrack = group.find((a) => a.default) || group[0] || null;
    }
    pl = await fetchPlaylist(variant.url, common);
    if (pl.kind !== 'media') throw new Error('Nieoczekiwana zagnieżdżona playlista master');
    if (audioTrack) audioPl = await fetchPlaylist(audioTrack.url, common);
  }

  for (const p of [pl, audioPl]) if (p?.encrypted) throw new Error(ENCRYPTED_MSG);
  if (!pl.segments.length) throw new Error('Playlista nie zawiera segmentów');

  const segmentsTotal = pl.segments.length + (audioPl?.segments.length || 0);
  const live = !pl.endList;
  onInfo?.({ variant, audioTrack, duration: pl.duration, segments: segmentsTotal, live });

  // Szacunek rozmiaru: z BANDWIDTH × czas, potem z średniej wielkości pobranych segmentów.
  const bwEstimate = variant?.bandwidth && pl.duration ? (variant.bandwidth / 8) * pl.duration : null;
  let loaded = 0;
  let segmentsDone = 0;
  const emit = () => {
    const total = segmentsDone >= 3 ? (loaded / segmentsDone) * segmentsTotal : bwEstimate;
    onProgress?.({ loaded, total, segmentsDone, segmentsTotal });
  };
  const hooks = {
    concurrency,
    ...common,
    onBytes: (n) => {
      loaded += n;
      emit();
    },
    onSegment: () => {
      segmentsDone++;
      emit();
    }
  };

  try {
    const [video, audio] = await Promise.all([
      downloadSegments(pl, hooks),
      audioPl ? downloadSegments(audioPl, { ...hooks, concurrency: Math.max(2, Math.ceil(concurrency / 3)) }) : null
    ]);
    return {
      video: { blob: video.blob, ext: containerExt(pl, false) },
      audio: audio ? { blob: audio.blob, ext: containerExt(audioPl, true) } : null,
      variant,
      duration: pl.duration,
      live
    };
  } catch (e) {
    ctrl.abort(e);
    throw outerSignal?.aborted ? abortReason(outerSignal) : e;
  }
}
