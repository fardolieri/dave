import { idbDelete, idbGet, idbRead, idbSet, local, type ParsedIdbKey } from './storage';
import { MAX_HISTORY, type PrivateThread, type StoredText } from '../core/chatlog';
import { IDB } from '../core/storedstate';
import { UNSENT_MAX, type UnsentPrivate, type UnsentText } from '../core/unsent';
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

const read = (key: ParsedIdbKey): Promise<StoredText[]> => idbRead(key);

export function loadHistory(roomId: string): Promise<StoredText[]> {
  return read(keyFor(roomId));
}

let chain: Promise<void> = Promise.resolve();
/**
 * Appends one line, de-duplicated by key, and by writer and id: a text sent again (another tab of mine took it over, say)
 * comes back with another time. Trims to the cap. Writes are serialised.
 */
export function appendHistory(roomId: string, m: StoredText): Promise<void> {
  return appendTo(keyFor(roomId), m);
}

function appendTo(key: `history:${string}` | `private:${string}`, m: StoredText): Promise<void> {
  chain = chain.then(async () => {
    const list = await read(key);
    // A private conversation's texts come through several rooms, each with its own clock: by writer and id alone there.
    const same = (x: StoredText) => (m.id !== undefined && x.id === m.id && x.from.publicKey === m.from.publicKey) || (!key.startsWith('private:') && textKey(x) === textKey(m));
    if (list.some(same)) return;
    list.push(m);
    await idbSet(key, list.slice(-MAX_HISTORY));
  }).catch((e) => console.warn('history write failed', e));
  return chain;
}

/**
 * My private conversation with a friend (ADR 0007), by their key: kept like a room's history, apart from every room.
 * Read after the writes queued before it, so a conversation deleted a moment ago reads as empty.
 */
export function loadPrivate(friend: string): Promise<StoredText[]> {
  const read_ = chain.then(() => read(`private:${friend}`));
  chain = read_.then(() => {}, () => {});
  return read_;
}
export const appendPrivate = (friend: string, m: StoredText): Promise<void> => appendTo(`private:${friend}`, m);

/** Deletes a private conversation from this browser: its texts and its place in the list. */
export function forgetPrivate(friend: string): Promise<void> {
  chain = chain.then(async () => {
    await idbDelete(`private:${friend}`);
    await idbSet('privateThreads', (await readThreads()).filter((t) => t.friend.publicKey !== friend));
  }).catch((e) => console.warn('private conversation delete failed', e));
  return chain;
}

/** My private conversations, most recent first (core/chatlog.ts). */
const readThreads = async (): Promise<PrivateThread[]> => IDB.privateThreads.parse(await idbGet<unknown>('privateThreads'));
/** Read after the writes queued before it, like `loadPrivate`. */
export function loadPrivateThreads(): Promise<PrivateThread[]> {
  const read_ = chain.then(readThreads);
  chain = read_.then(() => {}, () => {});
  return read_;
}
/** A text came or went in the conversation with `friend`: it goes to the top of the list, with their latest name. */
export function touchPrivateThread(friend: Identity, at: number): Promise<void> {
  chain = chain.then(async () => {
    const list = await readThreads();
    const was = list.find((t) => t.friend.publicKey === friend.publicKey);
    const next = [{ friend, at: Math.max(at, was?.at ?? 0) }, ...list.filter((t) => t !== was)].sort((a, b) => b.at - a.at);
    await idbSet('privateThreads', next);
  }).catch((e) => console.warn('private conversation list write failed', e));
  return chain;
}

export function clearHistory(roomId: string): Promise<void> {
  chain = chain.then(() => idbSet(keyFor(roomId), [])).catch((e) => console.warn('history clear failed', e));
  return chain;
}

/** Leaving a room: its history goes with it, as the leave dialog says. The link brings the room back, not the lines. */
export function forgetHistory(roomId: string): Promise<void> {
  forgetUnsent(roomId);
  chain = chain.then(() => idbDelete(keyFor(roomId))).catch((e) => console.warn('history delete failed', e));
  return chain;
}

/**
 * My own texts in a room that the Room has not brought back yet (core/unsent.ts), as a reload finds them. localStorage,
 * not IndexedDB: written as the text goes out, it must be there before a reload right after, with no write in flight.
 */
export const loadUnsent = (roomId: string): UnsentText[] => (local.read('unsent')[roomId] ?? []).slice(-UNSENT_MAX);

/** Keeps a room's texts not back from the Room yet; every room's entry is read afresh, so only this one changes. */
export function keepUnsent(roomId: string, texts: UnsentText[]): void {
  const all = local.read('unsent');
  if (texts.length) all[roomId] = texts.slice(-UNSENT_MAX);
  else delete all[roomId];
  if (Object.keys(all).length) local.set('unsent', JSON.stringify(all));
  else local.remove('unsent');
}

export const forgetUnsent = (roomId: string): void => { keepUnsent(roomId, []); keepUnsentPrivate(roomId, []); };

/** My private texts in a room not back from the Room yet (ADR 0007), as a reload finds them; kept like `unsent`. */
export const loadUnsentPrivate = (roomId: string): UnsentPrivate[] => local.read('unsentPrivate')[roomId] ?? [];

export function keepUnsentPrivate(roomId: string, texts: UnsentPrivate[]): void {
  const all = local.read('unsentPrivate');
  if (texts.length) all[roomId] = texts;
  else delete all[roomId];
  if (Object.keys(all).length) local.set('unsentPrivate', JSON.stringify(all));
  else local.remove('unsentPrivate');
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
