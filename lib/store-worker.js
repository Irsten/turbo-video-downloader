// Worker zapisu plików roboczych w OPFS (FileSystemSyncAccessHandle działa tylko w workerze).
// Polecenia są wykonywane po kolei, więc dwa zapisy do tego samego pliku się nie przeplatają.
const handles = new Map();
let root = null;
let queue = Promise.resolve();

async function handle(name) {
  let h = handles.get(name);
  if (!h) {
    root ??= await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    h = await fh.createSyncAccessHandle();
    handles.set(name, h);
  }
  return h;
}

function close(name) {
  const h = handles.get(name);
  if (h) {
    h.flush();
    h.close();
    handles.delete(name);
  }
}

async function run(m) {
  switch (m.op) {
    case 'open':
      return (await handle(m.name)).getSize();
    case 'write': {
      const h = await handle(m.name);
      const u8 = new Uint8Array(m.buf);
      let off = 0;
      while (off < u8.length) {
        const n = h.write(u8.subarray(off), { at: m.pos + off });
        if (!n) throw new Error('Brak miejsca na dysku');
        off += n;
      }
      return off;
    }
    case 'truncate':
      (await handle(m.name)).truncate(m.size);
      return null;
    case 'close':
      close(m.name);
      return null;
    case 'remove':
      close(m.name);
      root ??= await navigator.storage.getDirectory();
      await root.removeEntry(m.name).catch(() => {});
      return null;
    default:
      throw new Error('Nieznane polecenie ' + m.op);
  }
}

self.onmessage = ({ data: m }) => {
  queue = queue.then(async () => {
    try {
      self.postMessage({ id: m.id, result: await run(m) });
    } catch (e) {
      self.postMessage({ id: m.id, error: (e && e.message) || String(e) });
    }
  });
};
