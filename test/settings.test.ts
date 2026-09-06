import { describe, expect, it } from 'vitest';
import { DEFAULT_SHARE, applyPreset, contentHint, parseSettings, shareEncoding, trackConstraints, withChange, DEFAULT_AUDIO } from '../src/core/settings';

describe('share settings', () => {
  it('presets set the three knobs and are recognised again after manual changes', () => {
    const motion = applyPreset(DEFAULT_SHARE, 'motion');
    expect(motion).toMatchObject({ preset: 'motion', frameRate: 60, maxHeight: 720, degradation: 'maintain-framerate' });
    expect(withChange(motion, { frameRate: 30 }).preset).toBe('custom');
    expect(withChange(withChange(motion, { frameRate: 30 }), { frameRate: 60 }).preset).toBe('motion');
    expect(withChange(DEFAULT_SHARE, { budgetBps: 4_000_000 }).preset).toBe('detail'); // budget is not part of a preset
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
  });
});
