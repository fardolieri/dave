import { local } from './storage';

// Keys this browser has seen before, with the name they used. A key not in the
// list shows a "new" badge until the user acknowledges it (spec §3).
type Seen = Record<string, { name: string; since: number }>;

function read(): Seen {
  try { return JSON.parse(local.get('seenKeys') ?? '{}') as Seen; } catch { return {}; }
}

export function isKnown(publicKey: string): boolean {
  return publicKey in read();
}

export function markKnown(publicKey: string, name: string): void {
  const seen = read();
  seen[publicKey] = { name, since: Date.now() };
  local.set('seenKeys', JSON.stringify(seen));
}
