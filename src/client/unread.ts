import { local } from './storage';
import type { Counts } from '../core/unread';

// Unread counts kept over a reload (core/unread.ts), read from storage each time, not once: a tab that waited behind
// another (client/tablock.ts) and takes the rooms over later must not write back what it read before it waited.
type Scope = 'unreadRooms' | 'unreadPrivate';

/** All the counts of a scope. */
export const keptAll = (scope: Scope): Counts => local.read(scope) as Counts;
export const keptUnread = (scope: Scope, key: string): number => keptAll(scope)[key] ?? 0;

/** The counts of a scope as they are now; none at 0 is kept. */
export function keepAll(scope: Scope, counts: Counts): void {
  const next = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
  const json = JSON.stringify(next);
  if (json !== JSON.stringify(keptAll(scope))) local.set(scope, json);
}
export const keepUnread = (scope: Scope, key: string, n: number): void => keepAll(scope, { ...keptAll(scope), [key]: n });
