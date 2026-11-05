// What this browser keeps of the chat, texts and files together (ADR 0009): the window's four weeks at most
// (core/kept.ts, HISTORY_KEEP_MS), and no more than a share of what the browser gives this site, the oldest going first.
// Texts (client/history.ts) and files (client/files.ts) each say here what they hold, so either can make room.
import { FILE_STORE_BUDGET } from '../core/attachment';
import { textsMayHold } from '../core/chatlog';

/** The share of the browser's storage for this site that the chat may take: the rest is the browser's, and the app's. */
export const LOCAL_SHARE = 0.1;

let budget: Promise<number> | null = null;
/**
 * The bytes texts and files may take together, LOCAL_SHARE of the quota the browser reports, read once a page; the old
 * fixed budget for files where it reports none, or less than that.
 */
export function localBudget(): Promise<number> {
  budget ??= (async () => {
    try {
      const { quota } = await navigator.storage.estimate();
      if (typeof quota === 'number' && Number.isFinite(quota)) return Math.max(FILE_STORE_BUDGET, Math.floor(quota * LOCAL_SHARE));
    } catch { /* no estimate here: the fixed budget */ }
    return FILE_STORE_BUDGET;
  })();
  return budget;
}

/** What texts and files hold, as each last counted it: files from their index, texts by the histories read or written. */
export const held = { texts: 0, files: 0 };

/** What texts may hold of `budget` now, with what the files hold (core/chatlog.ts, textsMayHold). */
export const textsMay = (budget: number): number => textsMayHold(budget, held.files);
