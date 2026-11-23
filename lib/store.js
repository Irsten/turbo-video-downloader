// Pliki robocze pobierań. W przeglądarce leżą na dysku w OPFS (prywatny system plików
// rozszerzenia): pobierany film nie zajmuje pamięci, a po zamknięciu menedżera lub restarcie
// przeglądarki pobieranie da się wznowić. Zapis idzie przez worker z FileSystemSyncAccessHandle
// (zapis w miejscu, bez kopii pliku przy każdej zmianie).
//
// Wspólny interfejs (DiskFile i MemoryFile):
//   size                 – aktualny rozmiar
//   write(pos, u8)       – zapis pod pozycję (u8 zostaje przekazany workerowi – nie używaj go potem)
//   append(u8) -> pos    – dopisanie na końcu
//   truncate(n), blob(), remove()

let worker = null;
let seq = 0;
const waiting = new Map();

function call(op, args = {}, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./store-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) w?.reject(new Error(data.error));
      else w?.resolve(data.result);
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || 'Błąd zapisu na dysk'));
      waiting.clear();
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...args }, transfer);
  });
}

/** Bufor do przekazania workerowi bez kopiowania, gdy u8 obejmuje cały swój ArrayBuffer. */
function ownBuffer(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
}

export class DiskFile {
  constructor(name, size) {
    this.name = name;
    this.size = size;
  }
  static async open(name) {
    return new DiskFile(name, await call('open', { name }));
  }
  async write(pos, u8) {
    if (!u8.byteLength) return;
    const end = pos + u8.byteLength;
    const buf = ownBuffer(u8);
    await call('write', { name: this.name, pos, buf }, [buf]);
    if (end > this.size) this.size = end;
  }
  async append(u8) {
    const pos = this.size; // rezerwacja miejsca od razu – równoległe dopisywanie się nie nakłada
    this.size += u8.byteLength;
    await this.write(pos, u8);
    return pos;
  }
  async truncate(n) {
    await call('truncate', { name: this.name, size: n });
    this.size = n;
  }
  /** Zawartość jako File z dysku (dane nie są wczytywane do pamięci). */
  async blob() {
    await call('close', { name: this.name });
    const root = await navigator.storage.getDirectory();
    return (await root.getFileHandle(this.name)).getFile();
  }
  async remove() {
    await call('remove', { name: this.name });
  }
}

/** Nazwy plików roboczych zapisanych na dysku. */
export async function listDiskFiles() {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const name of root.keys()) names.push(name);
  return names;
}

export function removeDiskFile(name) {
  return call('remove', { name });
}

/** Ta sama obsługa w pamięci – testy w Node i awaryjnie, gdy OPFS jest niedostępny. */
export class MemoryFile {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.size = 0;
  }
  static async open() {
    return new MemoryFile();
  }
  async write(pos, u8) {
    const end = pos + u8.byteLength;
    if (end > this.buf.length) {
      const b = new Uint8Array(Math.max(end, this.buf.length * 2));
      b.set(this.buf.subarray(0, this.size));
      this.buf = b;
    }
    this.buf.set(u8, pos);
    if (end > this.size) this.size = end;
  }
  async append(u8) {
    const pos = this.size;
    this.size += u8.byteLength;
    await this.write(pos, u8);
    return pos;
  }
  async truncate(n) {
    this.size = Math.min(this.size, n);
  }
  async blob() {
    return new Blob([this.buf.slice(0, this.size)]);
  }
  async remove() {
    this.buf = new Uint8Array(0);
    this.size = 0;
  }
}
