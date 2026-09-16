import { idbDelete, idbGet, idbSet } from './storage';
import type { Identity } from '../core/protocol';

/**
 * Chat history kept in this browser only (ticket 09), one list per room. The server still stores nothing;
 * each friend keeps what reached them, so histories differ. Capped to the most recent MAX_HISTORY messages.
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
const keyFor = (roomId: string) => `history:${roomId}`;
/** Before rooms, this browser kept one history under a single key. */
const LEGACY_KEY = 'history';

const valid = (m: Partial<StoredText & StoredNote>) => !!m && typeof m.at === 'number' && (typeof m.note === 'string' || (typeof m.text === 'string' && !!m.from?.publicKey));
async function read(key: string): Promise<StoredLine[]> {
  const list = (await idbGet<StoredLine[]>(key)) ?? [];
  return Array.isArray(list) ? list.filter(valid).slice(-MAX_HISTORY) : [];
}

export function loadHistory(roomId: string): Promise<StoredLine[]> {
  return read(keyFor(roomId));
}

let chain: Promise<void> = Promise.resolve();
/** Appends one line, de-duplicated by key, trimming to the cap. Writes are serialised. */
export function appendHistory(roomId: string, m: StoredLine): Promise<void> {
  chain = chain.then(async () => {
    const list = await read(keyFor(roomId));
    if (list.some((x) => lineKey(x) === lineKey(m))) return;
    list.push(m);
    await idbSet(keyFor(roomId), list.slice(-MAX_HISTORY));
  }).catch((e) => console.warn('history write failed', e));
  return chain;
}

export function clearHistory(roomId: string): Promise<void> {
  chain = chain.then(() => idbSet(keyFor(roomId), [])).catch((e) => console.warn('history clear failed', e));
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
