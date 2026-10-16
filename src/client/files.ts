// The files this browser keeps (ADR 0006): bytes by SHA-256 in IndexedDB (`file:<hash>`), and an index of what is
// kept, oldest first (`files`), so the store stays within FILE_STORE_BUDGET. Shared by every room: a file announced in
// two rooms is kept once. Also the preview a sender makes of a picture or a video.
//
// Large files (attachments ticket 03) go in pieces to the Origin Private File System instead, where they are written as
// they come and never held whole: `big` below. Their lists of piece hashes and how far a pull got are in IndexedDB.
import { idbDelete, idbGet, idbSet } from './storage';
import { MAX_PREVIEW_LENGTH, PIECE_BYTES, PREVIEW_SIDE, inlineKind, keepWithin, listHash, parseBigIndex, parseFileIndex, parsePartialPull } from '../core/attachment';
import { toBase64Url } from '../core/identity';

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
 * A large file is written in segments of this size, each its own OPFS file, written once and never reopened: an OPFS
 * writer that keeps existing data starts as a copy of them, so reopening one file to commit copied all of it every time
 * (review of PR #72). The whole is the segments' Files in a Blob, which copies nothing. A pull that stops keeps its
 * complete segments and goes on after them.
 */
export const SEGMENT_BYTES = 16 * 1024 * 1024;
const segmentName = (hash: string, n: number) => `${hash}.${n}`;
/** Names OPFS refuses storage with: no room left, or no storage at all (a private window). */
const NO_ROOM = new Set(['QuotaExceededError', 'SecurityError', 'NotAllowedError']);
export const noRoom = (e: unknown): boolean => e instanceof DOMException && NO_ROOM.has(e.name);

/** Large files in the Origin Private File System, by hash: complete ones listed in `bigFiles`, partial ones in `partial:<hash>`. */
export const big = {
  /** Whether this browser can keep them: the Origin Private File System with writers (Chrome, Firefox, Safari 26). */
  available: (): boolean => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && 'createWritable' in (globalThis.FileSystemFileHandle?.prototype ?? {}),
  async dir(): Promise<FileSystemDirectoryHandle> { return (await navigator.storage.getDirectory()).getDirectoryHandle('files', { create: true }); },
  /** A complete large file, its segments as one Blob on disk, or null. */
  async complete(hash: string): Promise<Blob | null> {
    try {
      const entry = parseBigIndex(await idbGet<unknown>('bigFiles')).find((f) => f.hash === hash);
      if (!entry) return null;
      const dir = await big.dir();
      const count = Math.ceil(entry.size / SEGMENT_BYTES);
      const parts = await Promise.all(Array.from({ length: count }, async (_, n) => (await dir.getFileHandle(segmentName(hash, n))).getFile()));
      return new Blob(parts);
    } catch { return null; }
  },
  /** How many bytes of a pull of it are on disk and checked, in whole segments; 0 for none. */
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
   * A writer for a pull of it, from the first segment not on disk (`start`). Pieces come in order; a segment is closed,
   * which keeps it, when full, and the progress saved then. `end` drops a segment under way; `done` lists the file as
   * complete. Run it inside `exclusive`.
   */
  async writer(hash: string, size: number): Promise<{ start: number; write: (offset: number, bytes: ArrayBuffer) => Promise<void>; end: () => Promise<void>; done: () => Promise<Blob> }> {
    const dir = await big.dir();
    const start = Math.min(size, Math.floor((await big.verified(hash)) / SEGMENT_BYTES) * SEGMENT_BYTES);
    let segment = start / SEGMENT_BYTES;
    let filled = 0;
    let open: FileSystemWritableFileStream | null = null;
    // Saved before the first byte, so a pull that writes nothing is still swept after BIG_KEEP_MS.
    await idbSet(`partial:${hash}`, { verified: start, size, at: Date.now() });
    return {
      start,
      async write(offset, bytes) {
        if (offset !== segment * SEGMENT_BYTES + filled) throw new Error(`piece out of order at ${offset}`);
        // A fresh file: without keepExistingData nothing is copied into it.
        open ??= await (await dir.getFileHandle(segmentName(hash, segment), { create: true })).createWritable();
        await open.write(bytes);
        filled += bytes.byteLength;
        if (filled >= SEGMENT_BYTES || offset + bytes.byteLength >= size) {
          await open.close();
          open = null;
          segment++;
          filled = 0;
          await idbSet(`partial:${hash}`, { verified: Math.min(size, segment * SEGMENT_BYTES), size, at: Date.now() });
        }
      },
      async end() { await open?.abort().catch(() => undefined); open = null; },
      async done() {
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
