// What the server keeps of the rooms' chat (ADR 0009): every text and file announcement as the Room broadcast it, sealed,
// in one window for all rooms together, the oldest dropped first once it holds HISTORY_BUDGET_BYTES. A browser asks for
// what it missed after every welcome (`sync`), so a friend who was away, or on a new device, still gets it.
import { formatShare } from './relayusage';
import type { KeptEntry } from './protocol';

/**
 * The window: 80 % of the 5 GB of Durable Object storage the Workers Free plan gives the whole account
 * (developers.cloudflare.com/durable-objects/platform/pricing, 2026-11-03). The rest is for the rooms themselves and for
 * the previews' copies, which count against the same 5 GB. Free fails a write past it rather than billing.
 */
export const HISTORY_BUDGET_BYTES = 4_000_000_000;

/**
 * What one kept entry is counted as: its JSON, plus what its row and its two indexes cost on top (room, writer and id
 * twice over, and SQLite's own per-row overhead). Measured in workerd against `databaseSize`
 * (test/kept.test.ts), so that a full window stays inside the budget on disk too.
 */
export const ROW_OVERHEAD_BYTES = 512;
export const entryBytes = (json: string): number => new TextEncoder().encode(json).length + ROW_OVERHEAD_BYTES;

/**
 * The free plan's rows and requests are the account's, 100,000 rows written, 5 million read and 100,000 requests a day,
 * and the Rooms need theirs: a room's verifier is read on every challenge, every socket is a request. So the history
 * takes a share of each and no more, whoever asks: past it, until 00:00 UTC, texts go out live but are not kept, a sync
 * is answered `unavailable`, and a file's pieces are neither kept nor given. Writes are counted as SQLite counts them,
 * what a keep drops from the tail of the window included (one piece of a file kept into a window full of texts drops
 * hundreds of them at once), and the totals a keep, a piece given or every SYNCS_PER_WRITE syncs write. A kept text is
 * about four rows (its row, two indexes, the totals), seven once the window is full. A sync is one request to the
 * Store, asked on every welcome: a browser opens a socket per room and one per friend (ADR 0011), and the browser suite
 * against a preview a few thousand a run. What is left for the Rooms: 11,000 rows written (the syncs' own writes, below,
 * go past the share), a million read, and 60,000
 * requests less what keeps take.
 */
export const WRITES_PER_DAY = 85_000;
export const SYNCS_PER_DAY = 40_000;
export const SYNC_ROWS_PER_DAY = 4_000_000;
/**
 * Syncs, and the rows they and fetches that found nothing read, are counted in memory and written with the totals every
 * this many syncs, or sooner with a keep: a row written per sync would be as many rows as syncs. These writes go on
 * past WRITES_PER_DAY, 4,000 a day at most, or the syncs share would hold only until the next eviction. What an eviction
 * forgets is a few syncs of an idle object's, never of a busy one's, which stays awake.
 */
export const SYNCS_PER_WRITE = 10;

/**
 * Files the server keeps too (ADR 0009), encrypted in the browser: those up to this size, what a friend's app pulls by
 * itself (core/attachment.ts, PIECED_FROM). A larger one goes from friend to friend only: one 700 MB video would push
 * weeks of every room's texts out of the window.
 */
export const KEPT_FILE_MAX = 16 * 1024 * 1024;
/** Whether the server keeps a file of this kind: one of KEPT_FILE_MAX at most, not one that goes in large pieces. */
export const keptKind = (file: { size: number; piece?: number }): boolean => !file.piece && file.size <= KEPT_FILE_MAX;
/**
 * A kept file goes up and comes back in pieces of this many bytes, each its own entry in the window and its own frame:
 * as friends send each other files (core/attachment.ts, PIECE_BYTES), and well under the 2 MB a row of a Durable
 * Object's SQLite holds; a Durable Object takes frames up to 32 MiB (developers.cloudflare.com/durable-objects/platform/
 * limits, 2026-11-07). Larger pieces than the 256 KB before are fewer requests to the Store, rows and frames a file.
 */
export const KEPT_PIECE_BYTES = 1024 * 1024;
/** How many pieces a kept file has at most. */
export const KEPT_PIECES_MAX = Math.ceil(KEPT_FILE_MAX / KEPT_PIECE_BYTES);
/** How many pieces a file of `size` bytes goes in; an empty file is one empty piece. */
export const keptPiecesOf = (size: number): number => Math.max(1, Math.ceil(size / KEPT_PIECE_BYTES));
/** A piece as the window counts it: its sealed bytes, and its row as a text's. */
export const pieceBytes = (sealed: number): number => sealed + ROW_OVERHEAD_BYTES;
/** A piece's id among a room's entries: its file's hash and its place. */
export const pieceId = (hash: string, n: number): string => `${hash}:${n}`;

/** The most entries one `sync` brings: as many as a browser keeps of a room (core/chatlog.ts, MAX_HISTORY). */
export const SYNC_MAX = 500;
/** One `history` frame carries entries up to about this many UTF-16 units of JSON, at least one entry. */
export const SYNC_FRAME_BYTES = 256 * 1024;
/**
 * A browser asks for what came after the newest text it has, less this: the Room's clock is one object's, but the object
 * may move to another machine between two texts. What it has already is shown once anyway (by writer and id).
 */
export const SYNC_OVERLAP_MS = 5 * 60_000;
/** A socket asks once per this at most: a sync reads up to SYNC_MAX rows, which the free plan counts. */
export const SYNC_COOLDOWN_MS = 10_000;

/**
 * Where a room joined in this browser starts its history until its first sync is answered: past everything, so that sync
 * brings nothing, and its answer (`upTo`, the Room's clock) becomes the start (client/history.ts, `historyFrom`).
 */
export const FROM_JOIN = Number.MAX_SAFE_INTEGER;

/**
 * Where a browser asks from: after the point it last had everything up to (less the overlap), or after where its history
 * of the room starts (joined or last cleared), whichever is later; from the start when it has neither, a room this
 * browser held before starts were kept. The point is the room's `historySynced` (client/history.ts), or for a room
 * synced before it was kept, the newest text it holds.
 */
export function syncSince(syncedTo: number | null, from: number | null): number {
  return Math.max(0, syncedTo === null ? 0 : syncedTo - SYNC_OVERLAP_MS, from ?? 0);
}

type HistoryFrame = { t: 'history'; entries: KeptEntry[]; last?: true; upTo?: number; unavailable?: true };
/**
 * Entries in frames of about SYNC_FRAME_BYTES each, in order; one empty frame for none, so the answer always comes. The
 * last says up to when (`upTo`, the Room's clock), or that the server could not say (null entries).
 */
export function historyFrames(entries: readonly KeptEntry[] | null, upTo: number): HistoryFrame[] {
  if (entries === null) return [{ t: 'history', entries: [], last: true, unavailable: true }];
  const frames: HistoryFrame[] = [];
  let page: KeptEntry[] = [];
  let size = 0;
  for (const e of entries) {
    const n = JSON.stringify(e).length;
    if (page.length > 0 && size + n > SYNC_FRAME_BYTES) { frames.push({ t: 'history', entries: page }); page = []; size = 0; }
    page.push(e);
    size += n;
  }
  frames.push({ t: 'history', entries: page, last: true, upTo });
  return frames;
}

/** What the Worker's `/history-usage` answers, for the About dialog: the window's fill, and the oldest entry it still has. */
/** What today (UTC) used of the history's daily shares, as the Store counts them, and the shares. */
export type HistoryToday = { day: string; syncs: number; written: number; read: number };
export const HISTORY_SHARES: Omit<HistoryToday, 'day'> = { syncs: SYNCS_PER_DAY, written: WRITES_PER_DAY, read: SYNC_ROWS_PER_DAY };

export type HistoryUsage = { bytes: number; budget: number; entries: number; oldest: number | null; asOf: number; today?: HistoryToday; shares?: Omit<HistoryToday, 'day'> };

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** `today` and `shares` only when the Worker sent both, whole: a Worker from before them sends neither. */
export function parseHistoryUsage(json: unknown): HistoryUsage | null {
  const u = json as Partial<HistoryUsage> | null;
  if (!u || !num(u.bytes) || !num(u.budget) || u.budget === 0 || !num(u.entries) || !num(u.asOf) || !(u.oldest === null || num(u.oldest))) return null;
  const usage: HistoryUsage = { bytes: u.bytes, budget: u.budget, entries: u.entries, oldest: u.oldest, asOf: u.asOf };
  const t = u.today as Partial<HistoryToday> | undefined;
  const s = u.shares as Partial<HistoryToday> | undefined;
  if (t && s && typeof t.day === 'string' && num(t.syncs) && num(t.written) && num(t.read) && num(s.syncs) && num(s.written) && num(s.read) && s.syncs > 0 && s.written > 0 && s.read > 0) {
    usage.today = { day: t.day, syncs: t.syncs, written: t.written, read: t.read };
    usage.shares = { syncs: s.syncs, written: s.written, read: s.read };
  }
  return usage;
}

/** "1.2 MB of 4 GB (<0.1%)", as the relay's line. */
export const formatHistoryUsage = (u: HistoryUsage): string => formatShare(u.bytes, u.budget);
