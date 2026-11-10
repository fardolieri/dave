import { describe, expect, it } from 'vitest';
import { foldedCount, OLDER_STEP, olderCount, parseHistory, textsMayHold } from '../src/core/chatlog';

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

describe('foldedCount', () => {
  const at = (...ts: number[]) => ts.map((t) => ({ at: t }));
  it('folds the lines older than the cutoff when nothing was unread, or only newer lines were', () => {
    expect(foldedCount(at(1, 2, 5, 6), 5, null)).toBe(2);
    expect(foldedCount(at(1, 2, 5, 6), 5, 6)).toBe(2);
  });
  it('folds nothing from the oldest unread line on, however old', () => {
    expect(foldedCount(at(1, 2, 3, 4), 5, 3)).toBe(2);
    expect(foldedCount(at(1, 2, 3, 6), 5, 2)).toBe(1);
  });
  it('keeps at most the newest OLDER_STEP lines on screen for being unread, and every line newer than the cutoff', () => {
    const weeks = at(...Array.from({ length: OLDER_STEP + 300 }, (_, i) => i + 1));
    expect(foldedCount(weeks, 10_000, 1)).toBe(300);
    expect(foldedCount(weeks, 401, 1)).toBe(200);
    expect(foldedCount(weeks, 51, 1)).toBe(0);
  });
  it('folds no line that was on screen as newer ones arrive', () => {
    const weeks = at(...Array.from({ length: OLDER_STEP + 300 }, (_, i) => i + 1));
    expect(foldedCount([...weeks, { at: 20_000 }, { at: 20_001 }], 10_000, 1)).toBe(300);
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
