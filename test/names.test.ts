import { describe, expect, it } from 'vitest';
import { ambiguousNames, displayName, formatAgo, knownAgo, normaliseNickname, showsFingerprint } from '../src/core/names';

describe('displayName', () => {
  it('prefers the nickname this browser gave, else the self-declared name', () => {
    expect(displayName('zzzzzzz', undefined)).toBe('zzzzzzz');
    expect(displayName('zzzzzzz', { name: 'zzzzzzz', since: 0 })).toBe('zzzzzzz');
    expect(displayName('zzzzzzz', { name: 'zzzzzzz', since: 0, nick: 'Bob' })).toBe('Bob');
  });
});

describe('normaliseNickname', () => {
  it('trims, collapses whitespace and treats empty as "use their own name"', () => {
    expect(normaliseNickname('  Bob   the  Builder ')).toBe('Bob the Builder');
    expect(normaliseNickname('   ')).toBeNull();
    expect(normaliseNickname('')).toBeNull();
  });
  it('caps the length like a display name', () => {
    expect(normaliseNickname('x'.repeat(40))).toBe('x'.repeat(32));
  });
});

describe('ambiguousNames', () => {
  it('lists only names that more than one key shows', () => {
    const set = ambiguousNames([
      { publicKey: 'k1', shown: 'Bob' },
      { publicKey: 'k2', shown: 'Bob' },
      { publicKey: 'k3', shown: 'Alice' },
    ]);
    expect([...set]).toEqual(['Bob']);
  });
  it('does not count the same key twice, e.g. present and in the chat history', () => {
    expect(ambiguousNames([{ publicKey: 'k1', shown: 'Bob' }, { publicKey: 'k1', shown: 'Bob' }]).size).toBe(0);
  });
  it("catches a nickname that collides with someone else's name", () => {
    expect(ambiguousNames([{ publicKey: 'k1', shown: 'Bob' }, { publicKey: 'k2', shown: 'Bob' }]).has('Bob')).toBe(true);
  });
});

describe('showsFingerprint', () => {
  it('shows it for an unacknowledged key or an ambiguous name, hides it otherwise', () => {
    expect(showsFingerprint(false, 'Bob', new Set())).toBe(true);
    expect(showsFingerprint(true, 'Bob', new Set(['Bob']))).toBe(true);
    expect(showsFingerprint(true, 'Bob', new Set(['Alice']))).toBe(false);
  });
});

describe('formatAgo', () => {
  const noon = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime(); // local noon: a calendar day away from any boundary
  const now = noon(2026, 8, 9);
  it('counts calendar days, so late last night is yesterday', () => {
    expect(formatAgo(now - 3_600_000, now)).toBe('today');
    expect(formatAgo(new Date(2026, 8, 8, 23, 30).getTime(), now)).toBe('yesterday');
    expect(formatAgo(noon(2026, 8, 4), now)).toBe('5 days ago');
  });
  it('rounds to weeks, months and years with proper plurals', () => {
    expect(formatAgo(noon(2026, 8, 2), now)).toBe('1 week ago');
    expect(formatAgo(noon(2026, 7, 19), now)).toBe('3 weeks ago');
    expect(formatAgo(noon(2026, 7, 9), now)).toBe('1 month ago');
    expect(formatAgo(noon(2026, 3, 9), now)).toBe('5 months ago');
    expect(formatAgo(noon(2025, 8, 9), now)).toBe('1 year ago');
    expect(formatAgo(noon(2024, 6, 1), now)).toBe('2 years ago');
  });
  it('never looks into the future', () => {
    expect(formatAgo(now + 5 * 86_400_000, now)).toBe('today');
  });
});

describe('knownAgo', () => {
  const now = new Date(2026, 8, 9, 12).getTime();
  it('is undefined for a key never acknowledged, else the distance', () => {
    expect(knownAgo(undefined, now)).toBeUndefined();
    expect(knownAgo({ name: 'x', since: new Date(2026, 7, 19, 12).getTime() }, now)).toBe('3 weeks ago');
  });
});
