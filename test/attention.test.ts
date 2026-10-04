import { describe, expect, it } from 'vitest';
import { callDiff, sharesStarted, titleFor } from '../src/core/attention';

describe('attention cues', () => {
  it('badges the title only while hidden and while someone is in the call', () => {
    expect(titleFor(0, true)).toBe('dave');
    expect(titleFor(3, false)).toBe('dave');
    expect(titleFor(3, true)).toBe('(3 in call) dave');
  });
  it('diffs joins and leaves, ignoring yourself', () => {
    const d = callDiff(new Set(['me', 'a']), new Set(['me', 'b']), 'me');
    expect(d).toEqual({ joined: ['b'], left: ['a'] });
    expect(callDiff(new Set(['a']), new Set(['a', 'me']), 'me')).toEqual({ joined: [], left: [] });
  });
  it('treats a friend held through a server blip as neither left nor rejoined', () => {
    const held = new Set(['a']);
    expect(callDiff(new Set(['a', 'b']), new Set(['b']), 'me', held)).toEqual({ joined: [], left: [] });
    expect(callDiff(new Set(['b']), new Set(['a', 'b']), 'me', held)).toEqual({ joined: [], left: [] });
  });
  it('counts a share start only from someone already in the call who was not sharing', () => {
    const before = { present: new Set(['a', 'b']), sharing: new Set(['b']) };
    expect(sharesStarted(before, { sharing: new Set(['a', 'b']) })).toEqual(['a']);
    expect(sharesStarted(before, { sharing: new Set(['b', 'c']) })).toEqual([]); // c was away: a reconnect keeps the flag
  });
});
