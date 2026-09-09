import { createSignal } from 'solid-js';
import { local } from './storage';
import { normaliseNickname, type Contact } from '../core/names';

// The keys this browser has acknowledged, with the name they used and an optional nickname (issues #6 and #7).
// A key not in the book shows a "new" badge and its fingerprint until you acknowledge it (spec §3).
// Reactive, so a rename or an acknowledgement updates every row and chat line at once.
// The storage key predates nicknames and is kept so already acknowledged friends stay acknowledged.
type Book = Record<string, Contact>;
const KEY = 'seenKeys';

function read(): Book {
  try { return JSON.parse(local.get(KEY) ?? '{}') as Book; } catch { return {}; }
}

// `latest` is the source of truth for read-modify-write; the signal only mirrors it for the UI. Signal
// writes are batched, so two changes in one tick (two rows clicked at once) would otherwise both start
// from the same stale book and the second would drop the first.
let latest: Book = read();
const [book, setBook] = createSignal<Book>(latest);

function write(next: Book): void {
  latest = next;
  setBook(next);
  local.set(KEY, JSON.stringify(next));
}

export function contactOf(publicKey: string): Contact | undefined {
  return book()[publicKey];
}

export function isKnown(publicKey: string): boolean {
  return publicKey in book();
}

export function markKnown(publicKey: string, name: string): void {
  const current = latest[publicKey];
  write({ ...latest, [publicKey]: { since: Date.now(), ...current, name } });
}

/** Give a friend a nickname, or null to use their own name again. Naming someone also acknowledges their key. */
export function setNickname(publicKey: string, name: string, raw: string | null): void {
  const nick = raw === null ? null : normaliseNickname(raw);
  const current = latest[publicKey] ?? { name, since: Date.now() };
  const { nick: _drop, ...rest } = current;
  write({ ...latest, [publicKey]: nick ? { ...rest, name, nick } : { ...rest, name } });
}
