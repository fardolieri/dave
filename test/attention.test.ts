import { describe, expect, it } from 'vitest';
import { MIC_BACK_MS, MIC_LIVE_LEVEL, MIC_LOUD_LEVEL, MIC_SILENCE_MS, callDiff, createMicSilenceWatch, sharesStarted, titleFace, titleFor } from '../src/core/attention';

describe('attention cues', () => {
  it('shows the faces of the call in the title, focused or not, with a question for a silent microphone in front', () => {
    expect(titleFor([])).toBe('dave');
    expect(titleFor(['🦎', '𝗠', '☯️'])).toBe('dave 🦎𝗠☯️');
    expect(titleFor(['🦎'], true)).toBe('🔇❓ dave 🦎');
    expect(titleFor([], true)).toBe('🔇❓ dave');
  });
  it('shows a face as the profile picture, else the initial in bold', () => {
    expect(titleFace({ name: 'Dani', picture: '🦎' })).toBe('🦎');
    expect(titleFace({ name: 'mare' })).toBe('𝗠');
    expect(titleFace({ name: 'Zoë', picture: null })).toBe('𝗭');
    expect(titleFace({ name: 'Ömer' })).toBe('Ö');
  });
  /** Feeds the watch one level every 100 ms from `from` until `to`, and returns the last reading. */
  const feed = (watch: ReturnType<typeof createMicSilenceWatch>, level: (t: number) => number | null, from: number, to: number) => {
    let last = watch(level(from), from);
    for (let t = from + 100; t <= to; t += 100) last = watch(level(t), t);
    return last;
  };
  const muted = MIC_LIVE_LEVEL / 2, live = MIC_LIVE_LEVEL * 2;
  it('calls the microphone silent once a full minute was typically below the line, clicks and all', () => {
    const watch = createMicSilenceWatch();
    // A muted headset's hiss with a click now and then, louder than a live room but not loud.
    const hiss = (t: number) => (t % 5000 === 0 ? MIC_LOUD_LEVEL / 2 : muted);
    expect(feed(watch, hiss, 0, MIC_SILENCE_MS - 100).silent).toBe(false);
    const r = feed(watch, hiss, MIC_SILENCE_MS, MIC_SILENCE_MS);
    expect(r.silent).toBe(true);
    expect(r.median).toBe(muted);
  });
  it('never calls a live microphone in a quiet room silent', () => {
    const watch = createMicSilenceWatch();
    expect(feed(watch, (t) => (t % 3000 === 0 ? muted : live), 0, 5 * MIC_SILENCE_MS).silent).toBe(false);
  });
  it('is back within a second of a live level, at once on a loud moment, and waits a full minute again', () => {
    const watch = createMicSilenceWatch();
    feed(watch, () => muted, 0, MIC_SILENCE_MS);
    expect(feed(watch, () => live, MIC_SILENCE_MS + 100, MIC_SILENCE_MS + 400).silent).toBe(true);
    expect(feed(watch, () => live, MIC_SILENCE_MS + 500, MIC_SILENCE_MS + MIC_BACK_MS).silent).toBe(false);
    const t = MIC_SILENCE_MS + MIC_BACK_MS + 100;
    expect(feed(watch, () => muted, t, t + MIC_SILENCE_MS / 2).silent).toBe(false);
    expect(feed(watch, () => muted, t + MIC_SILENCE_MS / 2 + 100, t + MIC_SILENCE_MS).silent).toBe(true);
    expect(watch(MIC_LOUD_LEVEL * 2, t + MIC_SILENCE_MS + 100).silent).toBe(false);
  });
  it('starts the wait over while the microphone is closed or muted in the app', () => {
    const watch = createMicSilenceWatch();
    feed(watch, () => 0, 0, MIC_SILENCE_MS / 2);
    expect(watch(null, MIC_SILENCE_MS / 2 + 100).silent).toBe(false);
    const t = MIC_SILENCE_MS / 2 + 200;
    expect(feed(watch, () => 0, t, t + MIC_SILENCE_MS - 100).silent).toBe(false);
    expect(feed(watch, () => 0, t + MIC_SILENCE_MS, t + MIC_SILENCE_MS).silent).toBe(true);
  });
  const view = (present: string[], kept: string[] = []) => ({ present: new Set(present), kept: new Set(kept) });
  it('diffs joins and leaves, ignoring yourself', () => {
    const d = callDiff(view(['me', 'a']), view(['me', 'b']), 'me');
    expect(d).toEqual({ joined: ['b'], left: ['a'] });
    expect(callDiff(view(['a']), view(['a', 'me']), 'me')).toEqual({ joined: [], left: [] });
  });
  it('treats a friend kept on a connection through a server blip as neither left nor rejoined', () => {
    // Presence drops a, the connection to a stays, then a's socket is back (report of Oct 8).
    expect(callDiff(view(['a', 'b'], ['a', 'b']), view(['b'], ['a', 'b']), 'me')).toEqual({ joined: [], left: [] });
    expect(callDiff(view(['b'], ['a', 'b']), view(['a', 'b'], ['a', 'b']), 'me')).toEqual({ joined: [], left: [] });
  });
  it('lets a friend leave once presence and the connection are both gone, whichever goes last', () => {
    // A closed tab: presence first, the connection when it fails.
    expect(callDiff(view(['b'], ['a', 'b']), view(['b'], ['b']), 'me')).toEqual({ joined: [], left: ['a'] });
    // A deliberate leave: the `left` message closes the connection, then presence follows.
    expect(callDiff(view(['a', 'b'], ['a', 'b']), view(['a', 'b'], ['b']), 'me')).toEqual({ joined: [], left: [] });
    expect(callDiff(view(['a', 'b'], ['b']), view(['b'], ['b']), 'me')).toEqual({ joined: [], left: ['a'] });
    // Coming back after that is a join again.
    expect(callDiff(view(['b'], ['b']), view(['a', 'b'], ['b']), 'me')).toEqual({ joined: ['a'], left: [] });
  });
  it('counts a share start only from someone already in the call who was not sharing', () => {
    const before = { present: new Set(['a', 'b']), sharing: new Set(['b']) };
    expect(sharesStarted(before, { sharing: new Set(['a', 'b']) })).toEqual(['a']);
    expect(sharesStarted(before, { sharing: new Set(['b', 'c']) })).toEqual([]); // c was away: a reconnect keeps the flag
  });
});
