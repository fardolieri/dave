import { describe, expect, it } from 'vitest';
import { DEFAULT_SHARE, applyPreset, contentHint, parseSettings, shareEncoding, trackConstraints, withChange, DEFAULT_AUDIO, parseShareSettings, mbpsToBps } from '../src/core/settings';

describe('share settings', () => {
  it('presets set the three knobs and are recognised again after manual changes', () => {
    const motion = applyPreset(DEFAULT_SHARE, 'motion');
    expect(motion).toMatchObject({ preset: 'motion', frameRate: 60, maxHeight: 720, degradation: 'maintain-framerate' });
    expect(withChange(motion, { frameRate: 30 }).preset).toBe('custom');
    expect(withChange(withChange(motion, { frameRate: 30 }), { frameRate: 60 }).preset).toBe('motion');
    expect(withChange(DEFAULT_SHARE, { budgetBps: 4_000_000 }).preset).toBe('detail'); // budget is not part of a preset
    expect(withChange(DEFAULT_SHARE, { frameRate: 15 }).preset).toBe('detail'); // Detail spans 15 to 30 fps
  });
  it('derives track constraints, content hint, and per-viewer encodings', () => {
    expect(trackConstraints(DEFAULT_SHARE)).toEqual({ frameRate: { ideal: 30, max: 30 } });
    expect(trackConstraints(applyPreset(DEFAULT_SHARE, 'motion'))).toEqual({ frameRate: { ideal: 60, max: 60 }, height: { max: 720 } });
    expect(contentHint(DEFAULT_SHARE)).toBe('detail');
    expect(contentHint(applyPreset(DEFAULT_SHARE, 'motion'))).toBe('motion');
    expect(shareEncoding(DEFAULT_SHARE, 4, 1)).toEqual({ maxBitrate: 2_000_000, maxFramerate: 30, scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution' });
    expect(shareEncoding(withChange(DEFAULT_SHARE, { budgetBps: 4_000_000, ceilingBps: 1_500_000 }), 2, 2)).toEqual({ maxBitrate: 1_500_000, maxFramerate: 30, scaleResolutionDownBy: 2, degradationPreference: 'maintain-resolution' });
  });
  it('parses stored settings defensively', () => {
    expect(parseSettings(DEFAULT_SHARE, null)).toEqual(DEFAULT_SHARE);
    expect(parseSettings(DEFAULT_SHARE, '{"frameRate":60,"junk":1,"maxHeight":"720"}')).toEqual({ ...DEFAULT_SHARE, frameRate: 60 });
    expect(parseSettings(DEFAULT_AUDIO, 'not json')).toEqual(DEFAULT_AUDIO);
    // literal unions are validated, not just typed
    expect(parseShareSettings('{"frameRate":99,"degradation":"garbage","maxHeight":720,"budgetBps":-5}')).toEqual({ ...DEFAULT_SHARE, maxHeight: 720 });
  });
  it('clamps typed megabit values and ignores nonsense', () => {
    expect(mbpsToBps('4', 8_000_000, 1, 50)).toBe(4_000_000);
    expect(mbpsToBps('', 8_000_000, 1, 50)).toBe(8_000_000);
    expect(mbpsToBps('abc', 8_000_000, 1, 50)).toBe(8_000_000);
    expect(mbpsToBps('999', 8_000_000, 1, 50)).toBe(50_000_000);
    expect(mbpsToBps('0.1', 8_000_000, 1, 50)).toBe(1_000_000);
  });
});

describe('local volume', () => {
  it('clamps and parses stored volumes', async () => {
    const { clampVolume, parseVolumes } = await import('../src/core/settings');
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(7)).toBe(2); // 200 percent is the ceiling
    expect(clampVolume(1.5)).toBe(1.5);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume('x')).toBe(1);
    expect(parseVolumes('{"k1":0.3,"k2":"loud","k3":5}')).toEqual({ k1: 0.3, k3: 2 });
    expect(parseVolumes('nope')).toEqual({});
  });
});
