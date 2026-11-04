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
 * The free plan's rows are the account's, 100,000 written and 5 million read a day, and the Rooms need theirs: a room's
 * verifier is read on every challenge. So the history takes a share and no more, whoever asks: past it, until 00:00 UTC,
 * texts go out live but are not kept, and a sync is answered `unavailable`. A kept text is about four rows written (its
 * row, two indexes, the totals), seven once the window is full (an old one's row and indexes deleted), and a sync one
 * (the totals): 80,000 written at most, of 100,000. A day of friends chatting is a few thousand texts, and a sync is
 * asked on every welcome.
 */
export const KEEPS_PER_DAY = 10_000;
export const SYNCS_PER_DAY = 10_000;
export const SYNC_ROWS_PER_DAY = 2_000_000;

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
 * Where a browser asks from: after the point it last had everything up to (less the overlap), or after it last cleared
 * the room's history, whichever is later; from the start when it has no such point and never cleared. The point is the
 * room's `historySynced` (client/history.ts), or for a room synced before it was kept, the newest text it holds.
 */
export function syncSince(syncedTo: number | null, clearedAt: number | null): number {
  return Math.max(0, syncedTo === null ? 0 : syncedTo - SYNC_OVERLAP_MS, clearedAt ?? 0);
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
export type HistoryUsage = { bytes: number; budget: number; entries: number; oldest: number | null; asOf: number };

export function parseHistoryUsage(json: unknown): HistoryUsage | null {
  const u = json as Partial<HistoryUsage> | null;
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!u || !num(u.bytes) || !num(u.budget) || u.budget === 0 || !num(u.entries) || !num(u.asOf) || !(u.oldest === null || num(u.oldest))) return null;
  return { bytes: u.bytes, budget: u.budget, entries: u.entries, oldest: u.oldest, asOf: u.asOf };
}

/** "1.2 MB of 4 GB (<0.1%)", as the relay's line. */
export const formatHistoryUsage = (u: HistoryUsage): string => formatShare(u.bytes, u.budget);
