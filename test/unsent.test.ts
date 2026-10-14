import { describe, expect, it } from 'vitest';
import { parseUnsent, stillToSend, UNSENT_MAX, UNSENT_MAX_AGE_MS } from '../src/core/unsent';

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

  it('sends again only the newest, and nothing a day old', () => {
    const now = 10 * UNSENT_MAX_AGE_MS;
    const texts = Array.from({ length: UNSENT_MAX + 5 }, (_, i) => ({ id: `t${i}`, text: `${i}`, at: now - i * 1000 })).reverse();
    expect(stillToSend(texts, now)).toEqual(texts.slice(-UNSENT_MAX));
    expect(stillToSend([{ id: 'old', text: 'x', at: now - UNSENT_MAX_AGE_MS }, { id: 'new', text: 'y', at: now - 1 }], now).map((t) => t.id)).toEqual(['new']);
  });
});
