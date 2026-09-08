import { describe, expect, it } from 'vitest';
import { distinctFormats, formatBitrate, formatDuration, formatVideo } from '../src/core/format';

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

describe('formatBitrate', () => {
  it('uses kbps below a megabit and rounded Mbps above', () => {
    expect(formatBitrate(0)).toBe('0 kbps');
    expect(formatBitrate(849.6)).toBe('850 kbps');
    expect(formatBitrate(2440)).toBe('2.4 Mbps');
    expect(formatBitrate(2000)).toBe('2 Mbps');
    expect(formatBitrate(12_600)).toBe('13 Mbps');
  });
});

describe('formatVideo and distinctFormats', () => {
  it('prints resolution and rounded fps, omitting fps when no frames flow yet', () => {
    expect(formatVideo({ width: 1280, height: 720, fps: 29.7 })).toBe('1280×720 · 30 fps');
    expect(formatVideo({ width: 1920, height: 1080, fps: 0 })).toBe('1920×1080');
  });
  it('collapses equal formats and sorts largest first', () => {
    const out = distinctFormats([
      { width: 960, height: 540, fps: 60 }, { width: 1920, height: 1080, fps: 59.8 }, { width: 1920, height: 1080, fps: 60.2 }, { width: 0, height: 0, fps: 0 },
    ]);
    expect(out).toEqual([{ width: 1920, height: 1080, fps: 60 }, { width: 960, height: 540, fps: 60 }]);
  });
});
