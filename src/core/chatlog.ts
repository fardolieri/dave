import { identityOf, isIdentity, type Identity, type TextId } from './protocol';
import { parseFileMeta, type FileMeta } from './attachment';

/** Texts from more than this long before a room came on screen start out folded away above the log (ticket 38). */
export const FOLD_OLDER_MS = 18 * 3600 * 1000;
/** How many of them each "Show older messages" brings on screen, the newest first. */
export const OLDER_STEP = 200;

/**
 * What a browser's texts may hold of its budget for texts and files together (client/budget.ts), with `files` held: what
 * the files leave, and half of it whatever they hold, so files kept up to the budget never push the texts out. Past it,
 * the oldest texts go; files get what the texts hold less, and make room as the next one is kept (client/files.ts).
 */
export const textsMayHold = (budget: number, files: number): number => Math.max(budget / 2, budget - files);

/**
 * How many lines at the start of the log are older than `cutoff`. Only a run from the start folds, so what shows
 * is one piece of the conversation without holes; a stray older line after a newer one stays.
 */
export function olderCount(lines: ReadonlyArray<{ at: number }>, cutoff: number): number {
  const i = lines.findIndex((l) => l.at >= cutoff);
  return i === -1 ? lines.length : i;
}

/**
 * One text as this browser keeps it in its history (ticket 09, IndexedDB `history:<roomId>`). `id`: the writer's, since
 * 2026-10-14 (quality ticket 10), so a text sent again after a reload is still shown once; none in texts from before.
 * `file`: an attachment's announcement as opened (ADR 0006), since 2026-10-15; its `text` is the file's name.
 * `to`: a private text's friend (ADR 0007), since 2026-10-19: the one it went to, or me for one that came to me. An app
 * from before reads one as a text to the whole room, in this browser only: nothing is sent again.
 */
export type StoredText = { from: Identity; text: string; at: number; id?: TextId; file?: FileMeta; to?: Identity };
/**
 * My private conversations (ADR 0007), by friend, most recent first, as the sidebar lists them (IndexedDB
 * `privateThreads`): the friend as I last saw them, and when the last text came or went.
 */
export type PrivateThread = { friend: Identity; at: number };
/** A conversation list as read from IndexedDB: anything but a list of conversations with a friend is dropped. */
export function parsePrivateThreads(raw: unknown): PrivateThread[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((t: unknown): PrivateThread[] => {
    const v = t as Partial<PrivateThread> | null;
    if (!v || typeof v !== 'object' || typeof v.at !== 'number' || !isIdentity(v.friend) || seen.has(v.friend.publicKey)) return [];
    seen.add(v.friend.publicKey);
    return [{ friend: identityOf(v.friend), at: v.at }];
  });
}

/**
 * The list with `item` after every entry of the same time or earlier: texts the server's history brings (ADR 0009) are
 * older than some already shown, and go where their time says. One newer than all, as a live text is, goes last.
 */
export function insertByAt<T extends { at: number }>(list: readonly T[], item: T): T[] {
  let i = list.length;
  while (i > 0 && list[i - 1]!.at > item.at) i--;
  return [...list.slice(0, i), item, ...list.slice(i)];
}

/**
 * The list with `items` put in one after another as `insertByAt` puts one, in one copy: a sync's batch (ADR 0009). The
 * same places on a list out of order too (a system line has this browser's clock, a live text goes last).
 */
export function mergeByAt<T extends { at: number }>(list: readonly T[], items: readonly T[]): T[] {
  const out = [...list];
  for (const item of items) {
    let i = out.length;
    while (i > 0 && out[i - 1]!.at > item.at) i--;
    out.splice(i, 0, item);
  }
  return out;
}

// Only texts count. Until Sep 20 the list also held dated reconnect notes (`{ note, at }`); they are dropped
// here on read, so the next write leaves them out for good.
const validText = (m: Partial<StoredText> | null) => !!m && typeof m.at === 'number' && typeof m.text === 'string' && !!m.from?.publicKey;
/**
 * A stored history as read from IndexedDB: anything but a list of texts is dropped. An attachment
 * that does not parse is dropped too, and so is a private text whose friend does not: it must never show as everyone's.
 */
export function parseHistory(raw: unknown): StoredText[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Partial<StoredText> | null>).filter(validText).flatMap((m): StoredText[] => {
    if (m!.to !== undefined && !isIdentity(m!.to)) return [];
    if (m!.file === undefined) return [m as StoredText];
    const file = parseFileMeta(m!.file);
    return file ? [{ ...(m as StoredText), file }] : [];
  });
}
