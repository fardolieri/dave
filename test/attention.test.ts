import { describe, expect, it } from 'vitest';
import { callDiff, sharesStarted, titleFor } from '../src/core/attention';

describe('attention cues', () => {
  it('badges the title only while hidden and while someone is in the call', () => {
    expect(titleFor(0, true)).toBe('dave');
    expect(titleFor(3, false)).toBe('dave');
    expect(titleFor(3, true)).toBe('(3 in call) dave');
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
