import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/core/format';

describe('formatDuration', () => {
  it('rounds to whole seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(1400)).toBe('1 s');
    expect(formatDuration(47_600)).toBe('48 s');
    expect(formatDuration(-5)).toBe('0 s');
  });
  it('switches to minutes, hours and days', () => {
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(3 * 60_000 + 20_000)).toBe('3 min');
    expect(formatDuration(60 * 60_000)).toBe('1 h');
    expect(formatDuration(72 * 60_000)).toBe('1 h 12 min');
    expect(formatDuration(24 * 3_600_000)).toBe('1 d');
    expect(formatDuration(51 * 3_600_000)).toBe('2 d 3 h');
  });
});
