import { describe, expect, it } from 'vitest';
import { parseUnsent, parseUnsentPrivate, tooOld, UNSENT_MAX, UNSENT_MAX_AGE_MS } from '../src/core/unsent';
import { BURST } from '../src/core/ratelimit';

describe('texts kept over a reload (quality ticket 10)', () => {
  it('reads what was stored, room by room, and drops what is not a text', () => {
    const raw = JSON.stringify({
      roomA: [{ id: 'abc', text: 'hi', at: 1 }, { id: 'no spaces', text: 'x', at: 2 }, { id: 'def', text: 5, at: 3 }, null],
      roomB: 'junk',
      roomC: [{ id: 'ghi', text: 'yo', at: 4, extra: true }],
      roomD: [],
    });
    expect(parseUnsent(raw)).toEqual({ roomA: [{ id: 'abc', text: 'hi', at: 1 }], roomC: [{ id: 'ghi', text: 'yo', at: 4 }] });
  });

  it('takes a text that waited a day for too old to send', () => {
    const now = 10 * UNSENT_MAX_AGE_MS;
    expect(tooOld({ id: 'a', text: 'x', at: now - UNSENT_MAX_AGE_MS }, now)).toBe(true);
    expect(tooOld({ id: 'b', text: 'y', at: now - UNSENT_MAX_AGE_MS + 1 }, now)).toBe(false);
  });

  it('keeps fewer texts than the Room takes in one burst', () => {
    expect(UNSENT_MAX).toBeLessThan(BURST - 5);
  });
});

describe('private texts kept over a reload (ADR 0007)', () => {
  const ben = { publicKey: 'pkB', fingerprint: 'DEF456', name: 'Ben' };
  it('keeps those with a friend, and drops one whose friend does not parse: it must never go to the whole room', () => {
    const raw = JSON.stringify({ roomA: [
      { id: '0a1b2c3d4e5f60718293a4b5', to: ben, text: 'hi', at: 1 },
      { id: '1a1b2c3d4e5f60718293a4b5', text: 'no friend', at: 2 },
      { id: '2a1b2c3d4e5f60718293a4b5', to: { name: 'no key' }, text: 'bad friend', at: 3 },
    ], roomB: 'nope' });
    expect(parseUnsentPrivate(raw)).toEqual({ roomA: [{ id: '0a1b2c3d4e5f60718293a4b5', to: ben, text: 'hi', at: 1 }] });
    expect(parseUnsentPrivate(null)).toEqual({});
    expect(parseUnsentPrivate('{')).toEqual({});
  });
});
