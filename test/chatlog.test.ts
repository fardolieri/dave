import { describe, expect, it } from 'vitest';
import { olderCount } from '../src/core/chatlog';

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
