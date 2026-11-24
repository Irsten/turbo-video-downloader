// Working files of downloads. In the browser they live on disk in OPFS (the extension's private
// file system): a video being downloaded takes no memory, and after the manager is closed or the
// browser restarts the download can be resumed. Writes go through a worker with FileSystemSyncAccessHandle
// (in-place writes, no copy of the file on every change).
//
// Common interface (DiskFile and MemoryFile):
//   size                 – current size
//   write(pos, u8)       – write at a position (u8 is handed over to the worker – don't use it afterwards)
//   append(u8) -> pos    – append at the end
//   truncate(n), blob(), remove()
import { tr } from './i18n.js';

let worker = null;
let seq = 0;
const waiting = new Map();

function call(op, args = {}, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./store-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) w?.reject(new Error(data.error === 'NO_SPACE' ? tr('errNoSpace') : data.error));
      else w?.resolve(data.result);
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || tr('errDiskWrite')));
      waiting.clear();
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...args }, transfer);
  });
}

/** Buffer to hand over to the worker without copying, when u8 covers its whole ArrayBuffer. */
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
    const pos = this.size; // reserve the space right away – parallel appends don't overlap
    const len = u8.byteLength;
    this.size += len;
    try {
      await this.write(pos, u8);
    } catch (e) {
      // Give the space back if nothing was reserved after it – otherwise the file would keep a hole.
      if (this.size === pos + len) this.size = pos;
      throw e;
    }
    return pos;
  }
  async truncate(n) {
    await call('truncate', { name: this.name, size: n });
    this.size = n;
  }
  /** Contents as a File from disk (the data is not read into memory). */
  async blob() {
    await call('close', { name: this.name });
    const root = await navigator.storage.getDirectory();
    return (await root.getFileHandle(this.name)).getFile();
  }
  async remove() {
    await call('remove', { name: this.name });
  }
}

/** Names of the working files stored on disk. */
export async function listDiskFiles() {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const name of root.keys()) names.push(name);
  return names;
}

export function removeDiskFile(name) {
  return call('remove', { name });
}

/** The same in memory – for Node tests and as a fallback when OPFS is unavailable. */
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
