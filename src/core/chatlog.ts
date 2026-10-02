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
