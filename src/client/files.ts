// The files this browser keeps (ADR 0006): bytes by SHA-256 in IndexedDB (`file:<hash>`), and an index of what is
// kept, oldest first (`files`), so the store stays within FILE_STORE_BUDGET. Shared by every room: a file announced in
// two rooms is kept once. Also the preview a sender makes of a picture or a video.
//
// Large files (attachments ticket 03) go in pieces to the Origin Private File System instead, where they are written as
// they come and never held whole: `big` below. Their lists of piece hashes and how far a pull got are in IndexedDB.
import { idbDelete, idbGet, idbSet } from './storage';
import { MAX_PREVIEW_LENGTH, PIECE_BYTES, PREVIEW_SIDE, inlineKind, keepWithin, listHash, parseBigIndex, parseFileIndex, parsePartialPull } from '../core/attachment';
import { toBase64Url } from '../core/identity';
import type { WriterAnswer, WriterAsk } from './filewriter';

export async function hashOf(blob: Blob): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())));
}

let chain: Promise<unknown> = Promise.resolve();
/** Writes to the index are serialised, like the history's. */
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const next = chain.then(f);
  chain = next.catch(() => undefined);
  return next;
};

/** Keeps a file whose hash was checked; the oldest others go if the budget needs it. Fails quietly: it is still shown. */
export function keepFile(hash: string, blob: Blob): Promise<void> {
  return serial(async () => {
    const { index, drop, kept } = keepWithin(parseFileIndex(await idbGet<unknown>('files')), { hash, size: blob.size, at: Date.now() });
    for (const h of drop) await idbDelete(`file:${h}`);
    if (kept) await idbSet(`file:${hash}`, blob);
    await idbSet('files', index);
  }).catch((e: unknown) => console.warn('keeping a file failed', e));
}

/**
 * Files sent from this page, as picked: a File reads from disk, so holding it costs little, and the sender can serve it
 * even when the store could not keep it (over the budget, or storage refused).
 */
const sent = new Map<string, Blob>();
export const holdSent = (hash: string, file: Blob): void => { sent.set(hash, file); };

/** A kept file's bytes, or null: the store's copy (on disk), a large one complete on disk, else the one sent from this page. */
export async function keptFile(hash: string): Promise<Blob | null> {
  try {
    const blob = await idbGet<unknown>(`file:${hash}`);
    if (blob instanceof Blob) return blob;
  } catch { /* storage refused: the page's own copy, if any */ }
  return (await big.complete(hash)) ?? sent.get(hash) ?? null;
}

/**
 * The pieces' hashes of a file of `size`, read a piece at a time, and their list's hash: the announcement's `hash`.
 * `progress` hears the bytes read so far: a large file takes a while.
 */
export async function piecesOf(file: Blob, progress: (read: number) => void = () => {}): Promise<{ hash: string; list: Uint8Array }> {
  const count = Math.ceil(file.size / PIECE_BYTES);
  const list = new Uint8Array(count * 32);
  for (let i = 0; i < count; i++) {
    const bytes = await file.slice(i * PIECE_BYTES, (i + 1) * PIECE_BYTES).arrayBuffer();
    list.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), i * 32);
    progress(Math.min(file.size, (i + 1) * PIECE_BYTES));
  }
  return { hash: await listHash(list), list };
}

/** Large files kept this long after they came, and partial ones this long after their pull last moved. */
export const BIG_KEEP_MS = 3 * 24 * 3600 * 1000;
/**
 * A large file is one OPFS file named by its hash, written in place by a worker (client/filewriter.ts), each piece flushed
 * before the next: a pull that stops, a reload too, goes on after the last piece it checked. Until 2026-10-17 it was
 * written in segments of 16 MB, `<hash>.<n>`, which are still read and swept.
 */
const OLD_SEGMENT_BYTES = 16 * 1024 * 1024;
const oldSegmentName = (hash: string, n: number) => `${hash}.${n}`;
/** Names OPFS refuses storage with: no room left, no storage at all (a private window), or no writing in place. */
const NO_ROOM = new Set(['QuotaExceededError', 'SecurityError', 'NotAllowedError', 'NotSupportedError']);

/** The worker that writes one file, asked one thing at a time. Rejects with what it threw, as a DOMException. */
function fileWriter(): { ask: (ask: DistributiveOmit<WriterAsk, 'id'>, transfer?: Transferable[]) => Promise<WriterAnswer>; stop: () => void } {
  const worker = new Worker(new URL('./filewriter.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve: (a: WriterAnswer) => void; reject: (e: unknown) => void }>();
  let next = 0;
  const fail = (e: unknown) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  worker.onmessage = (e: MessageEvent<WriterAnswer>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (e.data.error) w?.reject(new DOMException(e.data.error.message, e.data.error.name));
    else w?.resolve(e.data);
  };
  worker.onerror = (e) => { e.preventDefault(); fail(new Error(`the file writer failed: ${e.message}`)); };
  return {
    ask: (ask, transfer = []) => new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...ask, id }, transfer);
    }),
    stop: () => { worker.terminate(); fail(new Error('the file writer stopped')); },
  };
}
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export const noRoom = (e: unknown): boolean => e instanceof DOMException && NO_ROOM.has(e.name);

/** Large files in the Origin Private File System, by hash: complete ones listed in `bigFiles`, partial ones in `partial:<hash>`. */
export const big = {
  /**
   * Whether this browser may keep them: the Origin Private File System and workers. Writing in place is seen only in the
   * worker: where it is missing (Safari before 15.2), a pull fails as "no room".
   */
  available: (): boolean => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && typeof Worker !== 'undefined',
  async dir(): Promise<FileSystemDirectoryHandle> { return (await navigator.storage.getDirectory()).getDirectoryHandle('files', { create: true }); },
  /** A complete large file on disk, or null. */
  async complete(hash: string): Promise<Blob | null> {
    try {
      const entry = parseBigIndex(await idbGet<unknown>('bigFiles')).find((f) => f.hash === hash);
      if (!entry) return null;
      const dir = await big.dir();
      const whole = await dir.getFileHandle(hash).then((h) => h.getFile(), () => null);
      if (whole?.size === entry.size) return whole;
      // One from before 2026-10-17: its segments' Files in a Blob, which copies nothing.
      const count = Math.ceil(entry.size / OLD_SEGMENT_BYTES);
      const parts = await Promise.all(Array.from({ length: count }, async (_, n) => (await dir.getFileHandle(oldSegmentName(hash, n))).getFile()));
      return new Blob(parts);
    } catch { return null; }
  },
  /** How many bytes of a pull of it are on disk and checked, from the start; 0 for none. */
  async verified(hash: string): Promise<number> { return parsePartialPull(await idbGet<unknown>(`partial:${hash}`).catch(() => undefined))?.verified ?? 0; },
  /** Its list of piece hashes, kept from a pull or a send. */
  async list(hash: string): Promise<Uint8Array | null> {
    const list = await idbGet<unknown>(`pieces:${hash}`).catch(() => undefined);
    return list instanceof Uint8Array ? list : null;
  },
  keepList: (hash: string, list: Uint8Array): Promise<void> => idbSet(`pieces:${hash}`, list).catch(() => undefined),
  /**
   * Runs a pull of it alone: one per file in this browser, every tab and room included, so two never write one segment
   * (a cancel and a click again, the same file in two rooms). The lock is let go when `run` ends.
   */
  exclusive: <T>(hash: string, run: () => Promise<T>): Promise<T> =>
    typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(`dave-big:${hash}`, run) : run(),
  /**
   * A writer for a pull of it in pieces of `piece`, from the first piece not on disk (`start`). Pieces come in order; each
   * is flushed to disk and the progress saved before the next. `end` lets the file go, as far as it got; `done` lists it
   * as complete. Run it inside `exclusive`.
   */
  async writer(hash: string, size: number, piece: number): Promise<{ start: number; write: (offset: number, bytes: ArrayBuffer) => Promise<void>; end: () => Promise<void>; done: () => Promise<Blob> }> {
    const dir = await big.dir();
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) if (name.startsWith(`${hash}.`)) names.push(name);
    const verified = await big.verified(hash);
    const writer = fileWriter();
    let start: number;
    try {
      let onDisk = (await writer.ask({ t: 'open', name: hash })).size ?? 0;
      // A pull stopped on the app before 2026-10-17 kept whole segments of 16 MB, `<hash>.<n>`: copied into the file, a
      // piece at a time, so it goes on where its button says (Grumpy Friend). Nothing is fetched again that is on disk.
      // Each segment goes once copied, so it never needs twice the room; a copy cut short goes on from the first segment
      // left, the ones before it being in the file.
      if (names.length) {
        let n = Math.floor(onDisk / OLD_SEGMENT_BYTES);
        onDisk = n * OLD_SEGMENT_BYTES;
        try {
          for (; n * OLD_SEGMENT_BYTES < verified; n++) {
            const segment = await (await dir.getFileHandle(oldSegmentName(hash, n))).getFile();
            for (let at = 0; at < segment.size; at += PIECE_BYTES) {
              const bytes = await segment.slice(at, at + PIECE_BYTES).arrayBuffer();
              const length = bytes.byteLength; // read before it goes: a buffer handed to the worker is empty here after
              await writer.ask({ t: 'write', at: onDisk, bytes }, [bytes]);
              onDisk += length;
            }
            await dir.removeEntry(oldSegmentName(hash, n)).catch(() => undefined);
          }
        } catch (e) {
          if (noRoom(e)) throw e;
          // A segment missing or unreadable: what was copied before it stands.
        }
        for (const name of names) await dir.removeEntry(name).catch(() => undefined);
      }
      // The file may be shorter than its record says (cleared by the browser), never trusted past it. All of it on disk:
      // nothing to ask for, not the last piece again.
      const kept = Math.min(verified, onDisk);
      start = kept >= size ? size : Math.floor(kept / piece) * piece;
      // Saved before the first byte, so a pull that writes nothing is still swept after BIG_KEEP_MS.
      await idbSet(`partial:${hash}`, { verified: start, size, at: Date.now() });
    } catch (e) {
      // Nobody gets this writer to end: its file is let go here.
      writer.stop();
      throw e;
    }
    let at = start;
    let closed = false;
    // A write and `end` take turns.
    let turns: Promise<unknown> = Promise.resolve();
    const turn = <T>(f: () => Promise<T>): Promise<T> => {
      const next = turns.then(f);
      turns = next.catch(() => undefined);
      return next;
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await writer.ask({ t: 'close' }); } finally { writer.stop(); }
    };
    return {
      start,
      write: (offset, bytes) => turn(async () => {
        if (closed) throw new Error('pull ended');
        if (offset !== at) throw new Error(`piece out of order at ${offset}`);
        const length = bytes.byteLength;
        await writer.ask({ t: 'write', at, bytes }, [bytes]);
        at += length;
        await idbSet(`partial:${hash}`, { verified: at, size, at: Date.now() });
      }),
      end: () => turn(close).catch(() => undefined),
      async done() {
        await turn(close);
        await serial(async () => {
          const index = parseBigIndex(await idbGet<unknown>('bigFiles')).filter((f) => f.hash !== hash);
          await idbSet('bigFiles', [...index, { hash, size, at: Date.now() }]);
        });
        await idbDelete(`partial:${hash}`);
        return (await big.complete(hash))!;
      },
    };
  },
  /**
   * Large files older than BIG_KEEP_MS go, with their lists, and partial ones whose pull has not moved for as long, or
   * that have no record. One a pull holds (`exclusive`) is left alone.
   */
  async sweep(now = Date.now()): Promise<void> {
    if (!big.available()) return;
    await serial(async () => {
      const dir = await big.dir();
      const index = parseBigIndex(await idbGet<unknown>('bigFiles'));
      const complete = new Set(index.filter((f) => now - f.at < BIG_KEEP_MS).map((f) => f.hash));
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      const hashes = new Set(names.map((n) => n.split('.')[0]!));
      for (const hash of hashes) {
        if (complete.has(hash)) continue;
        const partial = index.some((f) => f.hash === hash) ? null : parsePartialPull(await idbGet<unknown>(`partial:${hash}`).catch(() => undefined));
        if (partial && now - partial.at < BIG_KEEP_MS) continue;
        const held = await (typeof navigator !== 'undefined' && navigator.locks
          ? navigator.locks.request(`dave-big:${hash}`, { ifAvailable: true }, async (lock) => {
            if (!lock) return true;
            for (const n of names) if (n.split('.')[0] === hash) await dir.removeEntry(n).catch(() => undefined);
            return false;
          })
          : Promise.resolve(false));
        if (held) continue;
        await idbDelete(`partial:${hash}`);
        await idbDelete(`pieces:${hash}`);
      }
      await idbSet('bigFiles', index.filter((f) => complete.has(f.hash)));
    }).catch(() => undefined);
  },
};

/** A sent large file's list of piece hashes, held for this page: the sender serves the list before the bytes. */
const sentLists = new Map<string, Uint8Array>();
export const holdSentList = (hash: string, list: Uint8Array): void => { sentLists.set(hash, list); };
export const listOf = async (hash: string): Promise<Uint8Array | null> => sentLists.get(hash) ?? (await big.list(hash));

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));
const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** A frame of a video, a second in or less, and its size; null if the browser cannot play it. */
function videoFrame(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = () => { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
    const fail = () => { clearTimeout(timer); done(); resolve(null); };
    const timer = setTimeout(fail, 5000);
    video.muted = true;
    video.preload = 'auto';
    video.onerror = fail;
    video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 0) / 10); };
    video.onseeked = () => { clearTimeout(timer); resolve(video.videoWidth ? { source: video, width: video.videoWidth, height: video.videoHeight, done } : (done(), null)); };
    video.src = url;
  });
}

/**
 * The preview that goes with a picture or a video: at most PREVIEW_SIDE on its longest side, WebP where the browser
 * writes it, else JPEG, and the original's size. The original is not touched (ADR 0006). Null when there is none to make.
 */
export async function makePreview(file: Blob): Promise<{ preview?: string; width?: number; height?: number }> {
  const kind = inlineKind(file.type);
  if (!kind) return {};
  let frame: { source: CanvasImageSource; width: number; height: number; done: () => void } | null = null;
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file); // a GIF gives its first frame
      frame = { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
    } else frame = await videoFrame(file);
    if (!frame || !frame.width || !frame.height) return {};
    const scale = Math.min(1, PREVIEW_SIDE / Math.max(frame.width, frame.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    canvas.getContext('2d')!.drawImage(frame.source, 0, 0, canvas.width, canvas.height);
    const size = { width: frame.width, height: frame.height };
    for (const [type, quality] of [['image/webp', 0.6], ['image/jpeg', 0.6], ['image/jpeg', 0.3]] as const) {
      const blob = await canvasBlob(canvas, type, quality);
      // A browser that cannot write WebP writes PNG instead, which the announcement does not take.
      if (!blob || blob.type !== type) continue;
      const url = await dataUrl(blob);
      if (url.length <= MAX_PREVIEW_LENGTH) return { preview: url, ...size };
    }
    return size;
  } catch {
    return {};
  } finally {
    frame?.done();
  }
}
