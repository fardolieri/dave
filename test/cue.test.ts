import { describe, expect, it } from 'vitest';
import { CUE_GAIN, MINOR_SCALE, TIMBRES, VIBRATOS, joinCue, joinParts, leaveCue, melodySteps, noteGain } from '../src/core/cue';
import { EMOJI_CATEGORIES } from '../src/core/emoji';

const signature = (emoji: string) => JSON.stringify(joinCue(emoji));

describe('join and leave cues from the profile picture', () => {
  it('derives the same cue from the same emoji every time', () => {
    expect(signature('🦊')).toBe(signature('🦊'));
  });
  it('keeps the plain two-note chime for a friend without a picture', () => {
    expect(joinCue(null).notes.map((n) => n.freq)).toEqual([523.25, 659.25]);
    expect(joinCue(undefined)).toEqual(joinCue(null));
  });
  it('plays two or three notes that rise overall, spanning a third to a sixth, never leaping more than eight semitones', () => {
    let two = 0;
    for (const c of EMOJI_CATEGORIES) for (const { char } of c.entries) {
      const cue = joinCue(char);
      const f = cue.notes.map((n) => n.freq);
      expect(f.length === 2 || f.length === 3).toBe(true);
      if (f.length === 2) two++;
      expect(new Set(f).size).toBeGreaterThan(1);
      expect(f.at(-1)).toBeGreaterThanOrEqual(f[0]!);
      expect(Math.min(...f)).toBeGreaterThanOrEqual(261);
      const span = 12 * Math.log2(Math.max(...f) / Math.min(...f));
      expect(span).toBeLessThanOrEqual(8.01);
      expect(span).toBeGreaterThanOrEqual(3.99);
      expect(Math.max(...f)).toBeLessThanOrEqual(523.3); // C5
      expect(cue.notes.reduce((t, n) => t + n.seconds, 0)).toBeLessThanOrEqual(0.301);
    }
    expect(two / EMOJI_CATEGORIES.flatMap((c) => c.entries).length).toBeGreaterThan(0.42);
  });
  it('keeps every note within a sensible gain, low notes raised a little', () => {
    for (const c of EMOJI_CATEGORIES) for (const { char } of c.entries) {
      const cue = joinCue(char);
      for (const n of cue.notes) expect(noteGain(cue, n)).toBeLessThanOrEqual(CUE_GAIN * 1.2 * 1.3);
    }
    const low = joinCue('🍒');
    expect(noteGain(low, { freq: 262, seconds: 0.1 })).toBeGreaterThan(noteGain(low, { freq: 880, seconds: 0.1 }));
  });
  it('gives most emoji a cue of their own', () => {
    // The knob ranges that won three rounds of blind picks are far narrower than the first ones, so the 1082 emoji
    // share a few hundred cues; among a few friends in a call, two sharing one stays a rare coincidence, and a friend
    // can always pick another emoji.
    const all = EMOJI_CATEGORIES.flatMap((c) => c.entries.map((e) => e.char));
    expect(new Set(all.map(signature)).size / all.length).toBeGreaterThan(0.7);
  });
  it('gives five eighths of the emoji a second voice on the last note only, and an eighth fifths throughout', () => {
    const all = EMOJI_CATEGORIES.flatMap((c) => c.entries.map((e) => joinCue(e.char)));
    const lastOnly = all.filter((c) => c.notes.at(-1)!.with && !c.notes[0]!.with).length / all.length;
    const throughout = all.filter((c) => c.notes.every((n) => n.with)).length / all.length;
    expect(lastOnly).toBeGreaterThan(0.55); expect(lastOnly).toBeLessThan(0.7);
    expect(throughout).toBeGreaterThan(0.08); expect(throughout).toBeLessThan(0.17);
    for (const c of all) for (const n of c.notes) if (n.with) expect(Math.abs(12 * Math.log2(n.with / n.freq))).toBeLessThanOrEqual(9);
  });
  it('draws the mood and the wobble from the emoji: half bright, half moody; a quarter without wobble', () => {
    const chars = EMOJI_CATEGORIES.flatMap((c) => c.entries.map((e) => e.char));
    const moody = chars.filter((e) => joinParts(e).mood === 'moody');
    expect(moody.length / chars.length).toBeGreaterThan(0.42); expect(moody.length / chars.length).toBeLessThan(0.58);
    for (const e of moody.slice(0, 200)) {
      const { register } = joinParts(e);
      for (const n of joinCue(e).notes) expect(MINOR_SCALE.some((st) => Math.abs(12 * Math.log2(n.freq / 261.63) - register - st) < 0.02)).toBe(true);
    }
    const all = chars.map((e) => joinCue(e));
    for (const cue of all) expect(VIBRATOS).toContain(cue.vibrato);
    expect(all.filter((cue) => cue.vibrato === 0).length / all.length).toBeGreaterThan(0.18);
    expect(leaveCue('🦊').vibrato).toBe(joinCue('🦊').vibrato);
  });
  it('plays every emoji as a sine, the tone that won the picks', () => {
    for (const c of EMOJI_CATEGORIES) for (const e of c.entries) expect(joinCue(e.char).timbre).toBe('sine');
    expect(Object.keys(TIMBRES)).toEqual(['sine']);
  });
  it('shapes a tune from its digits: two steps wide at least, ending higher, never arching, two notes from the outer offsets', () => {
    expect(melodySteps(1, [0, 0, 0], 3)).toEqual([1, 1, 3]);
    expect(melodySteps(0, [3, 1, 2], 3)).toEqual([2, 1, 3]);
    expect(melodySteps(0, [0, 3, 2], 3)).toEqual([0, 2, 3]);
    expect(melodySteps(2, [3, 3, 3], 2)).toEqual([3, 5]);
    expect(melodySteps(0, [1, 2, 3], 2)).toEqual([1, 3]);
  });
  it('plays the leave backwards, lower, slower and quieter, so it falls where the join rose', () => {
    const join = joinCue('🦊');
    const leave = leaveCue('🦊');
    expect(leave.timbre).toBe(join.timbre);
    expect(leave.gain).toBeLessThan(join.gain);
    expect(leave.notes.at(-1)!.freq).toBeLessThanOrEqual(leave.notes[0]!.freq);
    const back = [...join.notes].reverse();
    leave.notes.forEach((n, i) => {
      expect(n.freq).toBeLessThan(back[i]!.freq);
      expect(n.seconds).toBeGreaterThan(back[i]!.seconds);
      expect(n.with === undefined).toBe(back[i]!.with === undefined);
    });
  });
});
