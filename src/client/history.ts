import { idbDelete, idbGet, idbSet, type IdbKey } from './storage';
import { MAX_HISTORY, parseHistory, type StoredText } from '../core/chatlog';
import type { Identity } from '../core/protocol';

/**
 * Chat history kept in this browser only (ticket 09), one list per room. The server still stores nothing;
 * each friend keeps what reached them, so histories differ. Capped to the most recent MAX_HISTORY messages.
 */
export type { StoredText };
/** De-duplication key: sender plus server timestamp. The wire format stays untouched. */
export const textKey = (m: { from: Identity; at: number }): string => `${m.from.publicKey}:${m.at}`;
const keyFor = (roomId: string): `history:${string}` => `history:${roomId}`;
/** Before rooms, this browser kept one history under a single key. */
const LEGACY_KEY = 'history';

async function read(key: IdbKey): Promise<StoredText[]> {
  return parseHistory(await idbGet<unknown>(key));
}

export function loadHistory(roomId: string): Promise<StoredText[]> {
  return read(keyFor(roomId));
}

let chain: Promise<void> = Promise.resolve();
/** Appends one line, de-duplicated by key, trimming to the cap. Writes are serialised. */
export function appendHistory(roomId: string, m: StoredText): Promise<void> {
  chain = chain.then(async () => {
    const list = await read(keyFor(roomId));
    if (list.some((x) => textKey(x) === textKey(m))) return;
    list.push(m);
    await idbSet(keyFor(roomId), list.slice(-MAX_HISTORY));
  }).catch((e) => console.warn('history write failed', e));
  return chain;
}

export function clearHistory(roomId: string): Promise<void> {
  chain = chain.then(() => idbSet(keyFor(roomId), [])).catch((e) => console.warn('history clear failed', e));
  return chain;
}

/** Leaving a room: its history goes with it, as the leave dialog says. The link brings the room back, not the lines. */
export function forgetHistory(roomId: string): Promise<void> {
  chain = chain.then(() => idbDelete(keyFor(roomId))).catch((e) => console.warn('history delete failed', e));
  return chain;
}

/** One-time: the history from before rooms belongs to the room the old single secret became. */
export function adoptLegacyHistory(roomId: string): Promise<void> {
  chain = chain.then(async () => {
    const legacy = await read(LEGACY_KEY);
    if (legacy.length > 0 && (await idbGet(keyFor(roomId))) === undefined) await idbSet(keyFor(roomId), legacy);
    await idbDelete(LEGACY_KEY);
  }).catch((e) => console.warn('history migration failed', e));
  return chain;
}
