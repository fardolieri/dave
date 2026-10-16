// Attachments (ADR 0006): what a file's announcement says, which files show inline, what this browser keeps, and the
// frames of a pull on a file link. Runtime-neutral: plain data and WebCrypto.
import { toBase64Url } from './identity';

/** A file as its sealed announcement describes it. The bytes travel apart, checked against `hash`. */
export type FileMeta = {
  /** The file's name as the sender's browser gave it, 1 to MAX_FILE_NAME characters. */
  name: string;
  /** The MIME type the sender's browser gave it; may be empty. Only decides how it is shown (inlineKind). */
  type: string;
  size: number;
  /** SHA-256 of the bytes, base64url, 43 characters. Names the file in a pull and in this browser's store. */
  hash: string;
  /** A small picture shown until the bytes are here: a data URL, WebP or JPEG. Pictures and videos only. */
  preview?: string;
  /** The picture's or video's own size in pixels, so the chat keeps its place while the bytes come. */
  width?: number;
  height?: number;
  /**
   * A large file is sent in pieces of this many bytes (attachments ticket 03). Then `hash` is the SHA-256 of the list
   * of its pieces' SHA-256s, which a puller fetches first: each piece is checked as it comes, kept on disk, and a pull
   * goes on from the last good one. Without it, `hash` is the whole file's.
   */
  piece?: number;
};

/** The most a file may weigh: far past anything friends send, a sanity bound for what an announcement may claim. */
export const MAX_FILE_BYTES = 2 ** 40;
/** The most a file sent whole may weigh: it is read, hashed and kept whole, in memory on the way. Larger ones go in pieces. */
export const WHOLE_FILE_MAX = 100 * 1024 * 1024;
/** Files larger than this go in pieces, kept on disk as they come (ticket 03); smaller ones whole, as before. */
export const PIECED_FROM = 16 * 1024 * 1024;
/** The size of a piece. */
export const PIECE_BYTES = 1024 * 1024;
/** The most pieces a file may have: its list of piece hashes is 32 bytes each. */
export const MAX_PIECES = 1024 * 1024;
/** How many pieces a file of `size` has. */
export const pieceCount = (size: number, piece: number): number => Math.ceil(size / piece);
/**
 * Pulls a browser runs at once per room, from anyone. A holder keeps as many links per friend (client/links.ts), so a
 * further ask from a friend means the oldest of their links is one they gave up, its goodbye lost.
 */
export const PULLS_AT_ONCE = 2;
/** Pictures and videos up to this size are pulled as they arrive; anything else waits for a click. */
export const AUTO_PULL_BYTES = 16 * 1024 * 1024;
/** What this browser keeps of files, its own and its friends'; the oldest go first. */
export const FILE_STORE_BUDGET = 300 * 1024 * 1024;
export const MAX_FILE_NAME = 255;
/** The preview's longest side, in pixels. */
export const PREVIEW_SIDE = 160;
/** The longest preview a client writes or takes, as a data URL. A 160 px WebP is 2 to 6 KB. */
export const MAX_PREVIEW_LENGTH = 12_000;
/** The longest announcement a client seals, in UTF-8 bytes: the preview, the name and the rest. */
export const MAX_FILE_BODY_BYTES = MAX_PREVIEW_LENGTH + 4 * MAX_FILE_NAME + 512;

/**
 * The types shown inline, as what they are; a blob URL has the app's origin, so nothing that can run script (SVG, HTML)
 * is ever among them. Anything else is offered as a download.
 */
const INLINE: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image', 'image/avif': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
};
export const inlineKind = (type: string): 'image' | 'video' | null => INLINE[type.toLowerCase()] ?? null;
/** Pulled as it arrives, without a click. */
export const pullsByItself = (f: FileMeta): boolean => inlineKind(f.type) !== null && f.size <= AUTO_PULL_BYTES;

const HASH = /^[A-Za-z0-9_-]{43}$/;
export const isFileHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
const PREVIEW = /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+=*$/;
const dimension = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 100_000;

/** An announcement as a friend's app wrote it: anything off is null, and the announcement is not shown. */
export function parseFileMeta(raw: unknown): FileMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.trim().length === 0 || m.name.length > MAX_FILE_NAME) return null;
  if (typeof m.type !== 'string' || m.type.length > 100) return null;
  if (!Number.isSafeInteger(m.size) || (m.size as number) < 0 || (m.size as number) > MAX_FILE_BYTES) return null;
  if (!isFileHash(m.hash)) return null;
  const meta: FileMeta = { name: m.name, type: m.type, size: m.size as number, hash: m.hash };
  if (m.piece !== undefined) {
    // A power of two from 64 KiB to 16 MiB, and at most MAX_PIECES of them: the list, fetched before the bytes, stays
    // within 32 MB however large the file.
    if (!Number.isSafeInteger(m.piece) || (m.piece as number) < 65_536 || (m.piece as number) > 16 * 1024 * 1024 || ((m.piece as number) & ((m.piece as number) - 1)) !== 0) return null;
    if (pieceCount(meta.size, m.piece as number) > MAX_PIECES) return null;
    meta.piece = m.piece as number;
  } else if (meta.size > WHOLE_FILE_MAX) return null;
  if (m.preview !== undefined) {
    if (typeof m.preview !== 'string' || m.preview.length > MAX_PREVIEW_LENGTH || !PREVIEW.test(m.preview)) return null;
    meta.preview = m.preview;
  }
  if (m.width !== undefined || m.height !== undefined) {
    if (!dimension(m.width) || !dimension(m.height)) return null;
    meta.width = m.width;
    meta.height = m.height;
  }
  return meta;
}

/** One file this browser keeps (IndexedDB `file:<hash>`), as its index `files` lists it. `at`: when it was kept. */
export type KeptFile = { hash: string; size: number; at: number };

/** The index of kept files as read from IndexedDB: anything but a list of entries is dropped. */
export function parseFileIndex(raw: unknown): KeptFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is KeptFile => !!f && typeof f === 'object' && isFileHash(f.hash) && Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.at === 'number');
}

/** A large file complete on disk (client/files.ts, IndexedDB `bigFiles`), outside the budget, gone after a few days. */
export type BigFile = { hash: string; size: number; at: number };
export function parseBigIndex(raw: unknown): BigFile[] { return parseFileIndex(raw); }
/** How far a pull of a large file got (IndexedDB `partial:<hash>`): checked bytes on disk, from the start. */
export type PartialPull = { verified: number; size: number; at: number };
export function parsePartialPull(raw: unknown): PartialPull | null {
  const p = raw as PartialPull | null | undefined;
  return p && typeof p === 'object' && Number.isSafeInteger(p.verified) && p.verified >= 0 && Number.isSafeInteger(p.size) && p.verified <= p.size && typeof p.at === 'number' ? { verified: p.verified, size: p.size, at: p.at } : null;
}

/**
 * Keeping `added` within `budget`: the index after it, and the files to let go, oldest first. A file kept already is
 * only moved to the newest end. One larger than the whole budget is not kept at all (it is still shown while the page
 * is open).
 */
export function keepWithin(index: readonly KeptFile[], added: KeptFile, budget = FILE_STORE_BUDGET): { index: KeptFile[]; drop: string[]; kept: boolean } {
  const rest = index.filter((f) => f.hash !== added.hash);
  if (added.size > budget) return { index: rest, drop: index.length === rest.length ? [] : [added.hash], kept: false };
  const next = [...rest, added];
  const drop: string[] = [];
  let total = next.reduce((n, f) => n + f.size, 0);
  while (total > budget) {
    const oldest = next.shift()!;
    total -= oldest.size;
    drop.push(oldest.hash);
  }
  return { index: next, drop, kept: true };
}

/**
 * The control frames of a pull, as JSON text on the link's data channel; the bytes follow as binary frames. The puller
 * asks for a file from an offset; the holder says it has it, with its size, and sends the bytes, or says it has not.
 */
export type PullFrame =
  | { t: 'get'; hash: string; offset: number }
  /** A pieced file's list of piece hashes, asked before its bytes: answered `have` with the list's length, then the list. */
  | { t: 'list'; hash: string }
  | { t: 'have'; size: number }
  | { t: 'none' };

export function parsePullFrame(raw: unknown): PullFrame | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  let m: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    m = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_FILE_BYTES;
  if (m.t === 'get' && isFileHash(m.hash) && count(m.offset)) return { t: 'get', hash: m.hash, offset: m.offset };
  if (m.t === 'list' && isFileHash(m.hash)) return { t: 'list', hash: m.hash };
  if (m.t === 'have' && count(m.size)) return { t: 'have', size: m.size };
  if (m.t === 'none') return { t: 'none' };
  return null;
}

/** "2.4 MB": a size as the chat says it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The SHA-256 of a pieced file's list of piece hashes, base64url: its `hash`. */
export async function listHash(list: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', list as BufferSource)));
}
