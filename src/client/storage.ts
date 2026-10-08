// Per-browser persistence. The identity keypair must live in IndexedDB because a
// non-extractable CryptoKey can only be stored by structured clone. Everything
// else is small strings in localStorage. Every key is listed, with its parser, in
// core/storedstate.ts: a key missing there does not typecheck here.
import type { IdbKey, LocalKey } from '../core/storedstate';

export type { IdbKey, LocalKey };

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

export async function idbDelete(key: IdbKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const local = {
  get: (key: LocalKey): string | null => {
    try { return localStorage.getItem(`dave.${key}`); } catch { return null; }
  },
  set: (key: LocalKey, value: string): void => {
    try { localStorage.setItem(`dave.${key}`, value); } catch { /* private mode etc. */ }
  },
  remove: (key: LocalKey): void => {
    try { localStorage.removeItem(`dave.${key}`); } catch { /* private mode etc. */ }
  },
};
