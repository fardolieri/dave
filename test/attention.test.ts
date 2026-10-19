import { describe, expect, it } from 'vitest';
import { MIC_ACTIVITY_LEVEL, MIC_SILENCE_MS, callDiff, createMicSilenceWatch, sharesStarted, titleFace, titleFor } from '../src/core/attention';

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
  it('calls the microphone silent after a minute without any sound, however quiet', () => {
    const watch = createMicSilenceWatch();
    const quiet = MIC_ACTIVITY_LEVEL / 2;
    expect(watch(quiet, 0).silent).toBe(false);
    expect(watch(quiet, MIC_SILENCE_MS - 1).silent).toBe(false);
    expect(watch(quiet, MIC_SILENCE_MS)).toEqual({ silent: true, peak: quiet });
    // Room noise the voice gate keeps back is sound: the wait starts over.
    expect(watch(0.001, MIC_SILENCE_MS + 1).silent).toBe(false);
    expect(watch(0, 2 * MIC_SILENCE_MS).silent).toBe(false);
    expect(watch(0, 2 * MIC_SILENCE_MS + 1).silent).toBe(true);
  });
  it('starts the wait over while the microphone is closed or muted in the app', () => {
    const watch = createMicSilenceWatch();
    watch(0, 0);
    expect(watch(null, MIC_SILENCE_MS).silent).toBe(false);
    expect(watch(0, MIC_SILENCE_MS + 1).silent).toBe(false);
    expect(watch(0, 2 * MIC_SILENCE_MS).silent).toBe(false);
    expect(watch(0, 2 * MIC_SILENCE_MS + 1).silent).toBe(true);
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
