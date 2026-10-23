// Per-browser persistence. The identity keypair must live in IndexedDB because a
// non-extractable CryptoKey can only be stored by structured clone. Everything
// else is small strings in localStorage. Every key is listed, with its parser, in
// core/storedstate.ts: a key missing there does not typecheck here, and every read
// of a parsed key goes through the parser listed there.
import { IDB, LOCAL, type IdbKey, type LocalKey } from '../core/storedstate';

export type { IdbKey, LocalKey };
/** What a read of a localStorage key gives: the return type of its parser in the registry. */
export type LocalValue<K extends LocalKey> = ReturnType<(typeof LOCAL)[K]['parse']>;

const DB = 'dave';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: IdbKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: IdbKey, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Keeps `value` under `key` unless something is stored there already, in one transaction, and returns what is stored
 * then: two tabs that race to make the same thing end up with the same one.
 */
export async function idbKeep<T>(key: IdbKey, value: T): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let kept: T = value;
    const req = store.get(key);
    req.onsuccess = () => {
      if (req.result === undefined) store.put(value, key);
      else kept = req.result as T;
    };
    tx.oncomplete = () => resolve(kept);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted')); // a full disk aborts at the commit
  });
}

export async function idbDelete(key: IdbKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The parsed IndexedDB keys; `identity` is read raw with idbGet. */
export type ParsedIdbKey = 'history' | `history:${string}` | `private:${string}`;
/** Reads an IndexedDB key through its parser in the registry. */
export async function idbRead(key: ParsedIdbKey): Promise<ReturnType<(typeof IDB)['history']['parse']>> {
  const entry = key === 'history' ? IDB.history : key.startsWith('private:') ? IDB['private:<friendKey>'] : IDB['history:<roomId>'];
  return entry.parse(await idbGet<unknown>(key));
}

function getRaw(key: LocalKey): string | null {
  try { return localStorage.getItem(`dave.${key}`); } catch { return null; }
}

export const local = {
  /** Reads a key through its parser in the registry (core/storedstate.ts). */
  read: <K extends LocalKey>(key: K): LocalValue<K> => (LOCAL[key].parse as (raw: string | null) => unknown)(getRaw(key)) as LocalValue<K>,
  set: (key: LocalKey, value: string): void => {
    try { localStorage.setItem(`dave.${key}`, value); } catch { /* private mode etc. */ }
  },
  remove: (key: LocalKey): void => {
    try { localStorage.removeItem(`dave.${key}`); } catch { /* private mode etc. */ }
  },
};
