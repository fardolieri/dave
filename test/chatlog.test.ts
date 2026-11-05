import { describe, expect, it } from 'vitest';
import { olderCount, parseHistory, textsMayHold } from '../src/core/chatlog';

describe('olderCount', () => {
  const at = (...ts: number[]) => ts.map((t) => ({ at: t }));
  it('counts the run of lines before the cutoff', () => {
    expect(olderCount(at(1, 2, 5, 6), 5)).toBe(2);
    expect(olderCount(at(5, 6), 5)).toBe(0);
    expect(olderCount(at(1, 2), 5)).toBe(2);
    expect(olderCount([], 5)).toBe(0);
  });
  it('stops at the first newer line, so nothing in between is skipped', () => {
    expect(olderCount(at(1, 7, 2, 8), 5)).toBe(1);
  });
});

describe('a stored history', () => {
  it('keeps every text, with no cap on how many: the window and the budget bound it (ADR 0009)', () => {
    const texts = Array.from({ length: 1200 }, (_, i) => ({ from: { publicKey: 'pkA', fingerprint: 'abc234' }, text: `t${i}`, at: i + 1 }));
    expect(parseHistory(texts)).toHaveLength(1200);
  });
});

describe('the budget for texts and files', () => {
  it('leaves the texts what the files do not hold, and half of it whatever they hold', () => {
    expect(textsMayHold(300, 100)).toBe(200);
    expect(textsMayHold(300, 0)).toBe(300);
    // Files kept up to the whole budget, as they were before texts shared it: the texts still have half.
    expect(textsMayHold(300, 300)).toBe(150);
    expect(textsMayHold(300, 400)).toBe(150);
  });
});
