import { idbGet, idbSet } from './storage';
import type { Identity } from '../core/protocol';

/**
 * Chat history kept in this browser only (ticket 09). The server still stores nothing; each friend
 * keeps what reached them, so histories differ. Capped to the most recent MAX_HISTORY messages.
 */
export type StoredText = { from: Identity; text: string; at: number };
/** De-duplication key: sender plus server timestamp. The wire format stays untouched. */
export const textKey = (m: { from: Identity; at: number }): string => `${m.from.publicKey}:${m.at}`;
export const MAX_HISTORY = 500;
const KEY = 'history';

export async function loadHistory(): Promise<StoredText[]> {
  const list = (await idbGet<StoredText[]>(KEY)) ?? [];
  return Array.isArray(list) ? list.filter((m) => m && typeof m.text === 'string' && typeof m.at === 'number' && m.from?.publicKey).slice(-MAX_HISTORY) : [];
}

let chain: Promise<void> = Promise.resolve();
/** Appends one message, de-duplicated by sender and timestamp, trimming to the cap. Writes are serialised. */
export function appendHistory(m: StoredText): Promise<void> {
  chain = chain.then(async () => {
    const list = await loadHistory();
    if (list.some((x) => textKey(x) === textKey(m))) return;
    list.push(m);
    await idbSet(KEY, list.slice(-MAX_HISTORY));
  }).catch((e) => console.warn('history write failed', e));
  return chain;
}

export function clearHistory(): Promise<void> {
  chain = chain.then(() => idbSet(KEY, [])).catch((e) => console.warn('history clear failed', e));
  return chain;
}
