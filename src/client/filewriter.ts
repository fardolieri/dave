// A dedicated worker that writes one large file in the Origin Private File System (client/files.ts, `big.writer`).
// Only a worker can open a file for writing in place (`createSyncAccessHandle`): each piece goes at its offset and is
// flushed to disk before the next, with nothing copied. A page's writers (`createWritable`) commit only on close, and
// one opened to go on copies the whole file first (review of PR #72), so a pull was kept only in whole segments of 16 MB,
// and one cut off under that started again from 0 (report of 2026-10-16).

/** What `createSyncAccessHandle` gives, which the DOM types do not name. */
type SyncAccess = {
  write(bytes: ArrayBufferView | ArrayBuffer, options: { at: number }): number;
  flush(): void;
  getSize(): number;
  close(): void;
};
export type WriterAsk =
  | { id: number; t: 'open'; name: string }
  | { id: number; t: 'write'; at: number; bytes: ArrayBuffer }
  | { id: number; t: 'close' };
export type WriterAnswer = { id: number; size?: number; error?: { name: string; message: string } };

let access: SyncAccess | null = null;

const scope = self as unknown as { onmessage: ((e: MessageEvent<WriterAsk>) => void) | null; postMessage(m: WriterAnswer): void };
// Asks are taken one at a time, in order.
let turns = Promise.resolve();
scope.onmessage = (e) => {
  const ask = e.data;
  turns = turns.then(async () => {
    try {
      if (ask.t === 'open') {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('files', { create: true });
        const handle = await dir.getFileHandle(ask.name, { create: true }) as unknown as { createSyncAccessHandle?: () => Promise<SyncAccess> };
        if (!handle.createSyncAccessHandle) throw new DOMException('No writing in place here', 'NotSupportedError');
        access = await handle.createSyncAccessHandle();
        scope.postMessage({ id: ask.id, size: access.getSize() });
      } else if (ask.t === 'write') {
        if (!access) throw new DOMException('Not open', 'InvalidStateError');
        const wrote = access.write(ask.bytes, { at: ask.at });
        if (wrote !== ask.bytes.byteLength) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        access.flush();
        scope.postMessage({ id: ask.id });
      } else {
        access?.close();
        access = null;
        scope.postMessage({ id: ask.id });
      }
    } catch (err) {
      const { name, message } = err instanceof Error ? err : { name: 'Error', message: String(err) };
      scope.postMessage({ id: ask.id, error: { name, message } });
    }
  });
};
