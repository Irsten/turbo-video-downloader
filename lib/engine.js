// Silnik pobierania: wiele równoległych połączeń (HTTP Range) z dzieleniem wolnych fragmentów
// w locie, równoległe segmenty HLS/DASH i nagrywanie transmisji na żywo.
// Dane trafiają od razu do pliku roboczego (DiskFile w OPFS albo MemoryFile), a stan pobierania
// (`resume`) to zwykły obiekt JSON: zapisany i podany ponownie sprawia, że silnik dociąga tylko
// brakujące bajty – także po zamknięciu menedżera albo restarcie przeglądarki.
// Działa w stronie rozszerzenia i w Node 18+ (testy) – używa tylko fetch.
import { parseM3U8, pickVariant, audioOptions } from './hls.js';
import { parseMpd } from './dash.js';

const MiB = 1024 * 1024;
const SPLIT_MIN_REMAINING = 4 * MiB; // dziel aktywny fragment, gdy zostało mu >= 4 MiB
const FLUSH_AT = MiB; // zapis na dysk porcjami po ~1 MiB
const FORBIDDEN_RETRIES = 2; // 403 zwykle oznacza wygasły link – długie ponawianie nic nie da
export const ENCRYPTED_MSG =
  'Ten strumień jest zaszyfrowany (DRM / klucz AES). Takich treści rozszerzenie nie pobiera.';
const REFRESH_HINT = 'Odśwież stronę z filmem i pobierz go ponownie.';

function httpMessage(status) {
  if (status === 401 || status === 403)
    return `Brak dostępu (HTTP ${status}) – link mógł wygasnąć albo wymaga zalogowania. ${REFRESH_HINT}`;
  if (status === 404 || status === 410)
    return `Pod tym adresem nie ma już pliku (HTTP ${status}) – link wygasł albo film usunięto. ${REFRESH_HINT}`;
  if (status === 429)
    return 'Serwer ogranicza liczbę żądań (HTTP 429) – zmniejsz liczbę połączeń w ustawieniach i spróbuj ponownie.';
  if (status >= 500) return `Błąd po stronie serwera (HTTP ${status}) – spróbuj ponownie za chwilę.`;
  return `Serwer odpowiedział HTTP ${status}`;
}

export class HttpError extends Error {
  constructor(status, url) {
    super(httpMessage(status));
    this.status = status;
    this.url = url;
  }
}

/** Serwer zwrócił stronę WWW / komunikat zamiast filmu (np. logowanie po wygaśnięciu linku). */
export class NotMediaError extends Error {
  constructor() {
    super(`Zamiast filmu serwer zwrócił stronę WWW – link prawdopodobnie wygasł albo wymaga zalogowania. ${REFRESH_HINT}`);
  }
}

const PAGE_MIME = /^\s*(text\/html|application\/xhtml\+xml|application\/json)\b/i;
const BLANK = new Set([0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf]); // białe znaki i BOM

/**
 * Czy odpowiedź to strona/komunikat, a nie film? Sam typ MIME nie wystarcza (skrypty PHP
 * potrafią wysłać film jako text/html), więc patrzymy też na początek treści:
 * żaden kontener wideo nie zaczyna się od „<”, „{” ani „[”.
 */
function isPage(contentType, bytes) {
  if (!PAGE_MIME.test(contentType || '')) return false;
  for (const b of bytes) if (!BLANK.has(b)) return b === 0x3c || b === 0x7b || b === 0x5b;
  return true;
}

/** Pierwszy kawałek treści odpowiedzi (potem połączenie jest zamykane). */
async function firstBytes(res) {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  try {
    return (await reader.read()).value || new Uint8Array();
  } catch {
    return new Uint8Array();
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Ile bajtów z poprzedniej próby wykorzysta ponowienie (0 = pobieranie od zera). */
export function resumableBytes(resume) {
  let n = 0;
  const visit = (s) => {
    for (const c of s?.chunks || []) n += c.received;
    for (const v of Object.values(s?.index || {})) n += v[1];
  };
  visit(resume);
  visit(resume?.video);
  visit(resume?.audio);
  return n;
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

function withHeaders(init, extra) {
  return { ...init, headers: { ...(init.headers || {}), ...extra } };
}

/** Skleja kawałki w jeden nowy bufor (można go przekazać do zapisu bez kopiowania). */
function join(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
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

// =====================================================================
// Pojedynczy plik
// =====================================================================

/**
 * Pobiera plik do `file`. Jeśli serwer obsługuje Range – na wielu połączeniach.
 * resume: { url, total, chunks: [{start, end, received}] } – wypełniany na bieżąco.
 * @returns {Promise<{size: number, contentType: string, ranged: boolean, connectionsUsed: number}>}
 */
export async function downloadFile(url, opts = {}) {
  const {
    file,
    resume = {},
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
    if (isPage(contentType, await firstBytes(probe))) throw new NotMediaError();
    if (m && Number(m[1]) > 0) {
      total = Number(m[1]);
      onProgress?.({ loaded, total });
      return rangedDownload();
    }
    return singleDownload(null);
  }
  return singleDownload(probe);

  // ---------- jedno połączenie (bez wznawiania – serwer nie obsługuje zakresów) ----------
  async function singleDownload(res) {
    Object.assign(resume, { url, total: null, chunks: null });
    for (let attempt = 1; ; attempt++) {
      let got = 0;
      try {
        if (!res) res = await fetchRetry(finalUrl, fetchInit, { retries, signal });
        const len = Number(res.headers.get('content-length')) || null;
        const encoded = !!res.headers.get('content-encoding');
        const ct = res.headers.get('content-type') || contentType;
        total = encoded ? null : len;
        let written = 0;
        let pend = [];
        let pendBytes = 0;
        const flush = async () => {
          if (!pendBytes) return;
          const data = join(pend, pendBytes);
          const n = pendBytes;
          pend = [];
          pendBytes = 0;
          await file.write(written, data);
          written += n;
        };
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (got === 0 && value.byteLength && isPage(ct, value)) throw new NotMediaError();
            pend.push(value);
            pendBytes += value.byteLength;
            got += value.byteLength;
            report(value.byteLength);
            if (pendBytes >= FLUSH_AT) await flush();
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        await flush();
        if (total && got < total) throw new Error('Połączenie zerwane przed końcem pliku');
        if (file.size > got) await file.truncate(got);
        total = got;
        onProgress?.({ loaded, total });
        return { size: got, contentType: ct, ranged: false, connectionsUsed: 1 };
      } catch (e) {
        if (signal.aborted) throw abortReason(signal);
        if (e instanceof NotMediaError) throw e;
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
    let all;
    if (resume.chunks && resume.url === url && resume.total === total && file.size > 0) {
      // Wznowienie: pobrane fragmenty są już w pliku, dociągamy tylko brakujące bajty.
      all = resume.chunks;
      for (const c of all) c.pending = 0;
      loaded = all.reduce((n, c) => n + c.received, 0);
      onProgress?.({ loaded, total, resumed: loaded > 0 });
    } else {
      const chunkSize = Math.max(minChunk, Math.min(maxChunk, Math.ceil(total / (connections * 4))));
      all = [];
      for (let s = 0; s < total; s += chunkSize) all.push({ start: s, end: Math.min(s + chunkSize, total) - 1, received: 0 });
      Object.assign(resume, { url, total, chunks: all });
    }
    const queue = all.filter((c) => c.start + c.received <= c.end).sort((a, b) => a.start - b.start);
    const active = new Set();
    const done = (c) => c.start + c.received + (c.pending || 0);

    // Gdy kolejka pusta: przejmij drugą połowę najwolniejszego (najdłuższego) aktywnego fragmentu.
    const takeWork = () => {
      if (queue.length) return queue.shift();
      let best = null;
      let bestRem = 0;
      for (const c of active) {
        const rem = c.end - done(c) + 1;
        if (rem > bestRem) (best = c), (bestRem = rem);
      }
      if (!best || bestRem < SPLIT_MIN_REMAINING) return null;
      const mid = done(best) + Math.floor(bestRem / 2);
      const nc = { start: mid, end: best.end, received: 0 };
      best.end = mid - 1;
      all.push(nc);
      return nc;
    };

    const fetchChunk = async (c) => {
      let attempt = 0;
      for (;;) {
        const from = c.start + c.received;
        if (from > c.end) return;
        let pend = [];
        c.pending = 0;
        const flush = async () => {
          if (!c.pending) return;
          const n = c.pending;
          const data = join(pend, n);
          pend = [];
          await file.write(c.start + c.received, data);
          c.received += n; // dopiero po zapisie – stan nigdy nie wyprzedza danych na dysku
          c.pending -= n;
        };
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
              if (done(c) > c.end) break;
              const { done: end, value } = await reader.read();
              if (end) break;
              const need = c.end - done(c) + 1; // koniec mógł się przesunąć (podział)
              if (need <= 0) break;
              const part = value.byteLength > need ? value.subarray(0, need) : value;
              pend.push(part);
              c.pending += part.byteLength;
              report(part.byteLength);
              attempt = 0; // są postępy – licznik prób od nowa
              if (c.pending >= FLUSH_AT) await flush();
            }
          } finally {
            reader.cancel().catch(() => {});
          }
          await flush();
          if (c.start + c.received > c.end) return;
          throw new Error('Połączenie zerwane w trakcie fragmentu');
        } catch (e) {
          // Pauza/anulowanie: to, co już przyszło, jest poprawne – zapisz, żeby wznowienie tego nie powtarzało.
          if (signal.aborted && c.pending) await flush().catch(() => {});
          report(-c.pending); // niezapisane bajty pobierzemy jeszcze raz
          c.pending = 0;
          pend = [];
          if (signal.aborted) throw abortReason(signal);
          const forbidden = e instanceof HttpError && e.status === 403;
          if (e instanceof HttpError && !retriableStatus(e.status) && !forbidden) throw e;
          if (++attempt > (forbidden ? FORBIDDEN_RETRIES : retries)) throw e;
          await sleep(backoff(attempt), signal); // wznowienie od ostatniego zapisanego bajtu
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
    // Błąd jednego wątku zatrzymuje resztę, ale zwracamy go dopiero, gdy wszystkie się zakończą –
    // dzięki temu stan fragmentów jest spójny z plikiem i ponowienie może z niego korzystać.
    let failure = null;
    await Promise.all(
      Array.from({ length: n }, () =>
        worker().catch((e) => {
          failure ??= e;
          ctrl.abort(e);
        })
      )
    );
    if (failure) throw outerSignal?.aborted ? abortReason(outerSignal) : failure;

    all.sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const c of all) {
      if (c.start !== pos || c.received !== c.end - c.start + 1) throw new Error('Błąd składania pliku z fragmentów');
      pos = c.end + 1;
    }
    if (pos !== total) throw new Error('Rozmiar złożonego pliku się nie zgadza');
    if (file.size > total) await file.truncate(total);
    return { size: total, contentType, ranged: true, connectionsUsed: n };
  }
}

// =====================================================================
// Segmenty (HLS, DASH)
// =====================================================================

/** Klucz segmentu w stanie wznawiania. */
export const segKey = (it) => (it.isMap ? 'map|' : `${it.seq ?? ''}|`) + it.url + (it.range ? `#${it.range[0]}-${it.range[1]}` : '');

/** Lista do pobrania: segmenty + sekcje inicjalizujące (EXT-X-MAP) tam, gdzie się zmieniają. */
function itemsOf(pl) {
  const items = [];
  let lastMap = null;
  for (const s of pl.segments) {
    if (s.map && (!lastMap || s.map.url !== lastMap.url || String(s.map.range) !== String(lastMap.range))) {
      items.push({ ...s.map, isMap: true });
      lastMap = s.map;
    }
    items.push(s);
  }
  return items;
}

/**
 * Pobiera segmenty równolegle i dopisuje każdy do `file`; state.index[klucz] = [pozycja, rozmiar].
 * Segmenty już obecne w state.index są pomijane (wznawianie).
 * skipMissing – segment 404/410 pomijany zamiast przerywać (transmisja na żywo przesunęła okno).
 */
async function downloadSegments(items, o) {
  const { file, state, concurrency, signal, abort, fetchInit, retries, prepare, onBytes, onSegment, onRestore, skipMissing } = o;
  state.index ??= {};
  const todo = items.filter((it) => !state.index[segKey(it)]);
  if (todo.length < items.length) {
    let bytes = 0;
    for (const it of items) bytes += state.index[segKey(it)]?.[1] || 0;
    onRestore?.(bytes, items.length - todo.length);
  }
  const prepared = new Set();
  for (const it of todo) {
    const host = new URL(it.url).host;
    if (!prepared.has(host)) {
      prepared.add(host);
      await prepare?.(it.url);
    }
  }

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
        const ct = res.headers.get('content-type') || '';
        const chunks = [];
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (got === 0 && value.byteLength && isPage(ct, value)) throw new NotMediaError();
            chunks.push(value);
            got += value.byteLength;
            onBytes(value.byteLength);
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        const len = Number(res.headers.get('content-length'));
        if (len && !res.headers.get('content-encoding') && got < len) throw new Error('Segment niepełny');
        let data = join(chunks, got);
        // Serwer zignorował Range przy BYTERANGE – wytnij właściwy kawałek.
        if (it.range && res.status === 200) data = data.slice(it.range[0], it.range[1] + 1);
        return data;
      } catch (e) {
        if (signal.aborted) throw abortReason(signal);
        onBytes(-got);
        if (e instanceof NotMediaError) throw e;
        if (skipMissing && e instanceof HttpError && (e.status === 404 || e.status === 410)) return null;
        const forbidden = e instanceof HttpError && e.status === 403;
        if (e instanceof HttpError && !retriableStatus(e.status) && !forbidden) throw e;
        if (attempt > (forbidden ? FORBIDDEN_RETRIES : retries)) throw e;
        await sleep(backoff(attempt), signal);
      }
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      const data = await fetchItem(it);
      if (!data) continue;
      const size = data.byteLength;
      const pos = await file.append(data);
      state.index[segKey(it)] = [pos, size];
      onSegment(it);
    }
  };

  // Jak przy plikach: przy błędzie czekamy, aż wszystkie wątki się zatrzymają.
  let failure = null;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, () =>
      worker().catch((e) => {
        failure ??= e;
        abort(e);
      })
    )
  );
  if (failure) throw failure;
}

/** Fragmenty pliku roboczego w kolejności odtwarzania. */
const partsOf = (state) => (state.order || []).map((k) => state.index?.[k]).filter(Boolean);

// =====================================================================
// HLS
// =====================================================================

export async function fetchPlaylist(url, { fetchInit = {}, signal, retries = 4, prepare } = {}) {
  await prepare?.(url);
  const res = await fetchRetry(url, fetchInit, { retries, signal });
  const text = await res.text();
  try {
    return parseM3U8(text, res.url || url);
  } catch (e) {
    if (PAGE_MIME.test(res.headers.get('content-type') || '')) throw new NotMediaError();
    throw e;
  }
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

async function fetchTexts(urls, { fetchInit, signal, retries, prepare }) {
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      await prepare?.(urls[i]);
      out[i] = await (await fetchRetry(urls[i], fetchInit, { retries, signal })).text();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  return out;
}

/**
 * Pobiera strumień HLS. Dla playlisty master wybiera wariant (variantUrl albo najlepszy) i ścieżkę
 * audio (audioUrl albo domyślną). subtitles: [{ url, name, language }] – napisy do pobrania.
 * record: transmisję na żywo nagrywa aż do stopSignal / końca transmisji.
 * openFile(rola) → plik roboczy dla 'video' / 'audio'. resume: { video, audio } – stan wznawiania.
 * onProgress({ loaded, total (szacunek), segmentsDone, segmentsTotal, recorded (s) })
 *
 * Zwraca { tracks: [{ role, parts, ext }], subtitles: [{ name, language, segments }], variant, audioTrack, duration, live }
 */
export async function downloadHls(url, opts = {}) {
  const {
    variantUrl,
    audioUrl,
    subtitles = [],
    record = false,
    stopSignal,
    openFile,
    resume = {},
    concurrency = 8,
    signal: outerSignal,
    onProgress,
    onInfo,
    prepare,
    fetchInit = {},
    retries = 6
  } = opts;
  const ctrl = linkedController(outerSignal);
  const signal = ctrl.signal;
  const common = { fetchInit, signal, retries, prepare };

  let pl = await fetchPlaylist(url, common);
  let variant = null;
  let audioTrack = null;
  let audioPl = null;
  let videoUrl = url;

  if (pl.kind === 'master') {
    if (pl.encrypted) throw new Error(ENCRYPTED_MSG);
    if (!pl.variants.length) throw new Error('Playlista nie zawiera żadnych wariantów');
    variant = pickVariant(pl, variantUrl);
    const audios = audioOptions(pl, variant);
    audioTrack = (audioUrl && audios.find((a) => a.url === audioUrl)) || audios[0] || null;
    videoUrl = variant.url;
    pl = await fetchPlaylist(videoUrl, common);
    if (pl.kind !== 'media') throw new Error('Nieoczekiwana zagnieżdżona playlista master');
    if (audioTrack) audioPl = await fetchPlaylist(audioTrack.url, common);
  }

  for (const p of [pl, audioPl]) if (p?.encrypted) throw new Error(ENCRYPTED_MSG);
  if (!pl.segments.length) throw new Error('Playlista nie zawiera segmentów');

  const live = !pl.endList;
  const recording = live && record;
  const roles = [{ role: 'video', pl, url: videoUrl }];
  if (audioPl) roles.push({ role: 'audio', pl: audioPl, url: audioTrack.url });
  for (const t of roles) {
    t.state = resume[t.role] ??= { index: {}, order: [] };
    t.state.index ??= {};
    t.state.order ??= [];
    t.file = await openFile(t.role);
  }
  const segmentsTotal = recording ? null : roles.reduce((n, t) => n + itemsOf(t.pl).length, 0);
  onInfo?.({ variant, audioTrack, duration: pl.duration, segments: segmentsTotal, live, recording });

  // Szacunek rozmiaru: z BANDWIDTH × czas, potem z średniej wielkości pobranych segmentów.
  const bwEstimate = variant?.bandwidth && pl.duration ? (variant.bandwidth / 8) * pl.duration : null;
  let loaded = 0;
  let segmentsDone = 0;
  let recorded = 0;
  const emit = (resumed) => {
    const total = recording ? null : segmentsDone >= 3 ? (loaded / segmentsDone) * segmentsTotal : bwEstimate;
    onProgress?.({ loaded, total, segmentsDone, segmentsTotal, recorded, resumed });
  };
  const hooks = {
    concurrency,
    ...common,
    abort: (e) => ctrl.abort(e),
    onBytes: (n) => {
      loaded += n;
      emit();
    },
    onSegment: () => {
      segmentsDone++;
      if (recording) recorded = recordedOf(roles);
      emit();
    },
    onRestore: (bytes, count) => {
      loaded += bytes;
      segmentsDone += count;
      if (recording) recorded = recordedOf(roles);
      emit(true);
    }
  };

  const runAll = async (lists, skipMissing) => {
    const res = await Promise.allSettled(
      roles.map((t, i) =>
        downloadSegments(lists[i], {
          ...hooks,
          file: t.file,
          state: t.state,
          skipMissing,
          concurrency: i ? Math.max(2, Math.ceil(concurrency / 3)) : concurrency
        })
      )
    );
    const bad = res.find((r) => r.status === 'rejected');
    if (bad) throw outerSignal?.aborted ? abortReason(outerSignal) : bad.reason;
  };

  if (!recording) {
    const lists = roles.map((t) => {
      const items = itemsOf(t.pl);
      const keys = items.map(segKey);
      // Nowe adresy (np. inny token) – stare dane w pliku nie pasują, zacznij tę ścieżkę od nowa.
      if (t.state.order.length && !keys.some((k) => t.state.index[k])) {
        t.state.index = {};
        t.reset = true;
      }
      t.state.order = keys;
      t.durations = new Map(items.map((it) => [segKey(it), it.duration || 0]));
      return items;
    });
    for (const t of roles) if (t.reset) await t.file.truncate(0);
    await runAll(lists, false);
  } else {
    await recordLive(roles, { runAll, common, signal, stopSignal, emit, setRecorded: () => (recorded = recordedOf(roles)) });
  }

  // Napisy (tylko nagranie VOD; to małe pliki tekstowe – zostają w pamięci).
  const subs = [];
  if (!recording) {
    for (const s of subtitles) {
      try {
        const spl = await fetchPlaylist(s.url, common);
        const segments = spl.kind === 'media' ? await fetchTexts(spl.segments.map((x) => x.url), common) : [];
        if (segments.length) subs.push({ name: s.name || '', language: s.language || '', segments });
      } catch (e) {
        if (signal.aborted) throw abortReason(signal);
        console.warn('Nie udało się pobrać napisów', s.url, e);
      }
    }
  }

  return {
    tracks: roles.map((t) => ({ role: t.role, parts: partsOf(t.state), ext: containerExt(t.pl, t.role === 'audio') })),
    subtitles: subs,
    variant,
    audioTrack,
    duration: recording ? recordedOf(roles) : pl.duration,
    live
  };
}

/** Długość nagrania (s): suma czasów pobranych segmentów wideo. */
function recordedOf(roles) {
  const t = roles[0];
  if (!t.durations) return 0;
  let s = 0;
  for (const [k, d] of t.durations) if (t.state.index[k]) s += d;
  return s;
}

/** Nagrywanie transmisji: odświeża playlisty i dopisuje nowe segmenty do zatrzymania lub końca. */
async function recordLive(roles, { runAll, common, signal, stopSignal, emit, setRecorded }) {
  const stopped = () => stopSignal?.aborted;
  const waitOrStop = (ms) =>
    new Promise((resolve, reject) => {
      if (stopped()) return resolve();
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        stopSignal?.removeEventListener('abort', done);
        signal.removeEventListener('abort', fail);
        resolve();
      }
      function fail() {
        clearTimeout(t);
        reject(abortReason(signal));
      }
      stopSignal?.addEventListener('abort', done, { once: true });
      signal.addEventListener('abort', fail, { once: true });
    });

  for (const t of roles) {
    t.durations ??= new Map();
    t.known = new Set(t.state.order);
  }
  let failures = 0;
  for (;;) {
    const lists = roles.map((t) => {
      const fresh = [];
      for (const it of itemsOf(t.pl)) {
        const k = segKey(it);
        if (!it.isMap) t.durations.set(k, it.duration || 0);
        if (t.known.has(k)) continue;
        t.known.add(k);
        t.state.order.push(k);
        fresh.push(it);
      }
      return fresh;
    });
    await runAll(lists, true);
    setRecorded();
    emit();
    if (stopped() || roles.every((t) => t.pl.endList)) return;
    const target = Math.min(...roles.map((t) => t.pl.targetDuration || 4));
    await waitOrStop(Math.min(6000, Math.max(1000, target * 500)));
    if (stopped()) return;
    try {
      for (const t of roles) t.pl = await fetchPlaylist(t.url, { ...common, retries: 2 });
      failures = 0;
    } catch (e) {
      if (signal.aborted) throw abortReason(signal);
      // Transmisja się skończyła albo playlista zniknęła – zachowujemy to, co nagrane.
      if (++failures >= 5) return;
    }
  }
}

// =====================================================================
// DASH
// =====================================================================

function dashExt(rep, role) {
  if (rep.container === 'webm') return 'webm';
  return role === 'audio' ? 'm4a' : 'mp4';
}

/**
 * Pobiera prezentację DASH: wybraną reprezentację obrazu (videoId) i dźwięku (audioId) oraz
 * napisy WebVTT (textIds). Wynik jak w downloadHls.
 */
export async function downloadDash(url, opts = {}) {
  const {
    videoId,
    audioId,
    textIds = [],
    openFile,
    resume = {},
    connections = 6,
    concurrency = 8,
    signal: outerSignal,
    onProgress,
    onInfo,
    prepare,
    fetchInit = {},
    retries = 6
  } = opts;
  const ctrl = linkedController(outerSignal);
  const signal = ctrl.signal;
  await prepare?.(url);
  const res = await fetchRetry(url, fetchInit, { retries, signal });
  const text = await res.text();
  let mpd;
  try {
    mpd = parseMpd(text, res.url || url);
  } catch (e) {
    if (PAGE_MIME.test(res.headers.get('content-type') || '') && !/<MPD/i.test(text)) throw new NotMediaError();
    throw e;
  }
  if (mpd.dynamic) throw new Error('Transmisje na żywo w formacie DASH nie są obsługiwane.');
  const pick = (list, id) => (id && list.find((r) => r.id === id)) || list.find((r) => !r.encrypted) || list[0] || null;
  const video = pick(mpd.video, videoId);
  const audio = pick(mpd.audio, audioId);
  if (video?.encrypted || audio?.encrypted) throw new Error(ENCRYPTED_MSG);
  if (!video && !audio) throw new Error('Manifest nie zawiera ścieżek do pobrania');
  onInfo?.({ variant: video, audioTrack: audio, duration: mpd.duration });

  const roles = [video && { role: 'video', rep: video }, audio && { role: 'audio', rep: audio }].filter(Boolean);
  const emit = (resumed) => {
    let loaded = 0;
    let total = 0;
    for (const t of roles) {
      loaded += t.loaded || 0;
      total += t.total ?? ((t.rep.bandwidth || 0) / 8) * mpd.duration;
    }
    onProgress?.({ loaded, total: total || null, resumed });
  };

  const results = await Promise.allSettled(
    roles.map(async (t) => {
      try {
        t.file = await openFile(t.role);
        t.state = resume[t.role] ??= {};
        if (t.rep.single) {
          const r = await downloadFile(t.rep.url, {
            file: t.file,
            resume: t.state,
            connections,
            signal,
            prepare,
            fetchInit,
            retries,
            onProgress: (p) => {
              t.loaded = p.loaded;
              t.total = p.total;
              emit(p.resumed);
            }
          });
          t.state.order = ['file'];
          t.state.index = { file: [0, r.size] };
        } else {
          const items = [t.rep.init && { ...t.rep.init, isMap: true }, ...t.rep.segments.map((s, i) => ({ ...s, seq: i }))].filter(Boolean);
          t.state.index ??= {};
          t.state.order = items.map(segKey);
          t.loaded = 0;
          await downloadSegments(items, {
            file: t.file,
            state: t.state,
            concurrency: t.role === 'audio' ? Math.max(2, Math.ceil(concurrency / 3)) : concurrency,
            signal,
            abort: (e) => ctrl.abort(e),
            fetchInit,
            retries,
            prepare,
            onBytes: (n) => {
              t.loaded += n;
              emit();
            },
            onSegment: () => emit(),
            onRestore: (bytes) => {
              t.loaded += bytes;
              emit(true);
            }
          });
        }
      } catch (e) {
        ctrl.abort(e);
        throw e;
      }
    })
  );
  const bad = results.find((r) => r.status === 'rejected');
  if (bad) throw outerSignal?.aborted ? abortReason(outerSignal) : bad.reason;

  const subs = [];
  for (const r of mpd.text.filter((x) => textIds.includes(x.id) && x.container === 'vtt' && x.single)) {
    try {
      await prepare?.(r.url);
      const vtt = await (await fetchRetry(r.url, fetchInit, { retries, signal })).text();
      subs.push({ name: r.label || '', language: r.lang || '', vtt });
    } catch (e) {
      if (signal.aborted) throw abortReason(signal);
      console.warn('Nie udało się pobrać napisów', r.url, e);
    }
  }

  return {
    tracks: roles.map((t) => ({ role: t.role, parts: partsOf(t.state), ext: dashExt(t.rep, t.role) })),
    subtitles: subs,
    variant: video,
    audioTrack: audio,
    duration: mpd.duration,
    live: false
  };
}
