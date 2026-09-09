// How a friend is shown in this browser. Runtime-neutral: plain data only.

/** What this browser remembers about a friend's key: the name they used, when the key was acknowledged, and an optional nickname. */
export type Contact = { name: string; since: number; nick?: string };

/** The name shown for a friend here: their nickname when this browser gave them one, else their self-declared name. */
export function displayName(selfDeclared: string, contact: Contact | undefined): string {
  return contact?.nick ?? selfDeclared;
}

/** A nickname as typed, ready to store: trimmed, inner whitespace collapsed; null when it is empty, meaning "use their own name". */
export function normaliseNickname(raw: string, max = 32): string | null {
  const nick = raw.trim().replace(/\s+/g, ' ');
  return nick.length >= 1 ? nick.slice(0, max) : null;
}

/** Shown names that more than one key uses. Those friends need their fingerprint next to the name; everyone else does not. */
export function ambiguousNames(entries: Iterable<{ publicKey: string; shown: string }>): Set<string> {
  const keysByName = new Map<string, Set<string>>();
  for (const e of entries) {
    const keys = keysByName.get(e.shown) ?? new Set<string>();
    keys.add(e.publicKey);
    keysByName.set(e.shown, keys);
  }
  return new Set([...keysByName].filter(([, keys]) => keys.size > 1).map(([name]) => name));
}

/**
 * Whether the fingerprint accompanies the name. It is there for exactly two situations: this browser has
 * never acknowledged the key, or someone else here shows the same name (issue #7).
 */
export function showsFingerprint(known: boolean, shown: string, ambiguous: Set<string>): boolean {
  return !known || ambiguous.has(shown);
}

/** How long ago this browser acknowledged the key, in calendar days: "today", "yesterday", "3 weeks ago". Undefined for a key never acknowledged. */
export function knownAgo(contact: Contact | undefined, now = Date.now()): string | undefined {
  return contact ? formatAgo(contact.since, now) : undefined;
}

const DAY_MS = 86_400_000;
const startOfDay = (t: number): number => new Date(new Date(t).toDateString()).getTime();
/** Rounded, calendar-based distance into the past: "today", "yesterday", "5 days ago", "3 weeks ago", "5 months ago", "2 years ago". */
export function formatAgo(at: number, now = Date.now()): string {
  const days = Math.max(0, Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (days < 7) return unit(days, 'day');
  if (days < 30) return unit(Math.max(1, Math.round(days / 7)), 'week');
  if (days < 365) return unit(Math.max(1, Math.round(days / 30.44)), 'month');
  return unit(Math.max(1, Math.round(days / 365.25)), 'year');
}
