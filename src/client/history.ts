import { idbGet, idbSet } from './storage';
import type { Identity } from '../core/protocol';

/**
 * Chat history kept in this browser only (ticket 09). The server still stores nothing; each friend
 * keeps what reached them, so histories differ. Capped to the most recent MAX_HISTORY messages.
 */
export type StoredText = { from: Identity; text: string; at: number };
/** A dated note this browser wrote about itself, e.g. that the server connection came back. */
export type StoredNote = { note: string; at: number };
export type StoredLine = StoredText | StoredNote;
export const isNote = (l: StoredLine): l is StoredNote => 'note' in l;
/** De-duplication key: sender plus server timestamp. The wire format stays untouched. */
export const textKey = (m: { from: Identity; at: number }): string => `${m.from.publicKey}:${m.at}`;
export const lineKey = (l: StoredLine): string => (isNote(l) ? `note:${l.at}` : textKey(l));
export const MAX_HISTORY = 500;
const KEY = 'history';

export async function loadHistory(): Promise<StoredLine[]> {
  const list = (await idbGet<StoredLine[]>(KEY)) ?? [];
  const valid = (m: Partial<StoredText & StoredNote>) => !!m && typeof m.at === 'number' && (typeof m.note === 'string' || (typeof m.text === 'string' && !!m.from?.publicKey));
  return Array.isArray(list) ? list.filter(valid).slice(-MAX_HISTORY) : [];
}

let chain: Promise<void> = Promise.resolve();
/**
 * Appends one line, de-duplicated by key, trimming to the cap. Writes are serialised. Identical notes
 * with no message between them mark the same gap, so the later one replaces the earlier.
 */
export function appendHistory(m: StoredLine): Promise<void> {
  chain = chain.then(async () => {
    const list = await loadHistory();
    const last = list[list.length - 1];
    if (isNote(m) && last && isNote(last) && last.note === m.note) list.pop();
    else if (list.some((x) => lineKey(x) === lineKey(m))) return;
    list.push(m);
    await idbSet(KEY, list.slice(-MAX_HISTORY));
  }).catch((e) => console.warn('history write failed', e));
  return chain;
}

export function clearHistory(): Promise<void> {
  chain = chain.then(() => idbSet(KEY, [])).catch((e) => console.warn('history clear failed', e));
  return chain;
}
