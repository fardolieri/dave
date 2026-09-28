import { describe, expect, it } from 'vitest';
import { DEFAULT_SHARE, contentHint, parseSettings, shareEncoding, trackConstraints, withChange, DEFAULT_AUDIO, parseShareSettings, parseAudioSettings, mbpsToBps, captureProcessing, processingIsDefault } from '../src/core/settings';

describe('share settings', () => {
  it('starts at native resolution and 60 fps, and a change touches only the named knob', () => {
    expect(DEFAULT_SHARE).toMatchObject({ frameRate: 60, maxHeight: 0, degradation: 'maintain-resolution', budgetBps: 20_000_000, ceilingBps: 6_000_000 });
    expect(withChange(DEFAULT_SHARE, { frameRate: 30 })).toEqual({ ...DEFAULT_SHARE, frameRate: 30 });
  });
  it('derives track constraints, content hint, and per-viewer encodings', () => {
    const motion = withChange(DEFAULT_SHARE, { maxHeight: 720, degradation: 'maintain-framerate' });
    expect(trackConstraints(DEFAULT_SHARE)).toEqual({ frameRate: { ideal: 60, max: 60 } });
    expect(trackConstraints(motion)).toEqual({ frameRate: { ideal: 60, max: 60 }, height: { max: 720 } });
    expect(contentHint(DEFAULT_SHARE)).toBe('detail');
    expect(contentHint(motion)).toBe('motion');
    expect(shareEncoding(DEFAULT_SHARE, 4, 1)).toEqual({ maxBitrate: 5_000_000, maxFramerate: 60, scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution' });
    expect(shareEncoding(withChange(DEFAULT_SHARE, { budgetBps: 4_000_000, ceilingBps: 1_500_000 }), 2, 2)).toEqual({ maxBitrate: 1_500_000, maxFramerate: 60, scaleResolutionDownBy: 2, degradationPreference: 'maintain-resolution' });
  });
  it('parses stored settings defensively', () => {
    expect(parseSettings(DEFAULT_SHARE, null)).toEqual(DEFAULT_SHARE);
    expect(parseSettings(DEFAULT_SHARE, '{"frameRate":30,"junk":1,"maxHeight":"720"}')).toEqual({ ...DEFAULT_SHARE, frameRate: 30 });
    expect(parseSettings(DEFAULT_AUDIO, 'not json')).toEqual(DEFAULT_AUDIO);
    // literal unions are validated, not just typed
    expect(parseShareSettings('{"frameRate":99,"degradation":"garbage","maxHeight":720,"budgetBps":-5}')).toEqual({ ...DEFAULT_SHARE, maxHeight: 720 });
    // blobs from before the profiles were removed still carry a preset field; it is dropped like any unknown field
    expect(parseShareSettings('{"preset":"detail","frameRate":30}')).toEqual({ ...DEFAULT_SHARE, frameRate: 30 });
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
  it('the master volume is part of the audio settings and must lie within the slider range', () => {
    expect(parseAudioSettings(null).masterVolume).toBe(1);
    expect(parseAudioSettings('{"masterVolume":0.5}').masterVolume).toBe(0.5);
    expect(parseAudioSettings('{"masterVolume":2}').masterVolume).toBe(2);
    expect(parseAudioSettings('{"masterVolume":7}').masterVolume).toBe(1); // out of range falls back rather than blasting
    expect(parseAudioSettings('{"masterVolume":"loud"}').masterVolume).toBe(1);
    expect(parseAudioSettings('{"speakerId":"abc"}')).toEqual({ ...DEFAULT_AUDIO, speakerId: 'abc' }); // older blobs without the field
  });
});

describe('voice repair (ticket 34)', () => {
  it('defaults to the browsers\' own FEC, takes the three modes, and drops anything else', () => {
    expect(DEFAULT_AUDIO.voiceRepair).toBe('fec');
    expect(parseAudioSettings('{"voiceRepair":"red"}').voiceRepair).toBe('red');
    expect(parseAudioSettings('{"voiceRepair":"off"}').voiceRepair).toBe('off');
    expect(parseAudioSettings('{"voiceRepair":"ulp"}').voiceRepair).toBe('fec');
    expect(parseAudioSettings('{"lowBandwidthVoice":true}').voiceRepair).toBe('fec'); // older blobs without the field
  });
});

describe('noise removal (ticket 26)', () => {
  it('is on by default with the gate at 0.5, and older blobs without the fields get both', () => {
    expect(DEFAULT_AUDIO).toMatchObject({ noiseRemoval: true, voiceThreshold: 0.5 });
    expect(parseAudioSettings('{"echoCancellation":false}')).toEqual({ ...DEFAULT_AUDIO, echoCancellation: false });
  });
  it('keeps the threshold within the slider range', () => {
    expect(parseAudioSettings('{"voiceThreshold":0}').voiceThreshold).toBe(0);
    expect(parseAudioSettings('{"voiceThreshold":0.8}').voiceThreshold).toBe(0.8);
    expect(parseAudioSettings('{"voiceThreshold":1.5}').voiceThreshold).toBe(0.5);
    expect(parseAudioSettings('{"voiceThreshold":-1}').voiceThreshold).toBe(0.5);
  });
  it('switches the browser noise suppression off only while noise removal runs', () => {
    expect(captureProcessing(DEFAULT_AUDIO, true)).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    expect(captureProcessing(DEFAULT_AUDIO, false)).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(captureProcessing({ ...DEFAULT_AUDIO, noiseSuppression: false }, false).noiseSuppression).toBe(false);
  });
  it('counts noise removal as the noise suppression when judging whether processing is at its default', () => {
    expect(processingIsDefault({ ...DEFAULT_AUDIO, noiseSuppression: false })).toBe(true);
    expect(processingIsDefault({ ...DEFAULT_AUDIO, noiseRemoval: false })).toBe(true);
    expect(processingIsDefault({ ...DEFAULT_AUDIO, noiseRemoval: false, noiseSuppression: false })).toBe(false);
    expect(processingIsDefault({ ...DEFAULT_AUDIO, echoCancellation: false })).toBe(false);
  });
});
