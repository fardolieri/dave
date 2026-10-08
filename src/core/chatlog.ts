import type { Identity } from './protocol';

/** Texts from more than this long before a room came on screen start out folded away above the log (ticket 38). */
export const FOLD_OLDER_MS = 18 * 3600 * 1000;

/**
 * How many lines at the start of the log are older than `cutoff`. Only a run from the start folds, so what shows
 * is one piece of the conversation without holes; a stray older line after a newer one stays.
 */
export function olderCount(lines: ReadonlyArray<{ at: number }>, cutoff: number): number {
  const i = lines.findIndex((l) => l.at >= cutoff);
  return i === -1 ? lines.length : i;
}

/** One text as this browser keeps it in its history (ticket 09, IndexedDB `history:<roomId>`). */
export type StoredText = { from: Identity; text: string; at: number };
/** The history keeps the most recent texts only. */
export const MAX_HISTORY = 500;

// Only texts count. Until Sep 20 the list also held dated reconnect notes (`{ note, at }`); they are dropped
// here on read, so the next write leaves them out for good.
const validText = (m: Partial<StoredText> | null) => !!m && typeof m.at === 'number' && typeof m.text === 'string' && !!m.from?.publicKey;
/** A stored history as read from IndexedDB: anything but a list of texts is dropped, and the list is capped. */
export function parseHistory(raw: unknown): StoredText[] {
  return Array.isArray(raw) ? (raw as Array<Partial<StoredText> | null>).filter(validText).slice(-MAX_HISTORY) as StoredText[] : [];
}
