import { describe, expect, it } from 'vitest';
import { parseUnsent, tooOld, UNSENT_MAX, UNSENT_MAX_AGE_MS } from '../src/core/unsent';
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
