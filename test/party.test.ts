import { describe, expect, it } from 'vitest';
import { MAX_PARTY_BODY_BYTES, change, current, driftAllowed, fromSeeking, jumped, later, parseParty, partyText, positionAt, sameChange, seekMore, type Party } from '../src/core/party';

const ALICE = 'a'.repeat(87);
const BOB = 'b'.repeat(87);
const party = (over: Partial<Party> = {}): Party => ({ n: 1, by: ALICE, hash: 'h'.repeat(43), video: 'dQw4w9WgXcQ', playing: true, pos: 10, rate: 1, at: 1_000_000, ...over });

describe('a watch party (core/party.ts)', () => {
  it('reads back what it seals, and nothing off', () => {
    const p = party({ pos: 12.3456789 });
    expect(parseParty(partyText(p))).toEqual({ ...p, pos: 12.346 });
    expect(new TextEncoder().encode(partyText(party({ n: Number.MAX_SAFE_INTEGER, pos: 99999.999, at: Number.MAX_SAFE_INTEGER, rate: 0.25 }))).length).toBeLessThanOrEqual(MAX_PARTY_BODY_BYTES);
    for (const off of [{ n: 0 }, { n: 1.5 }, { by: 'k-alice' }, { hash: 'short' }, { video: 'not a video' }, { playing: 'yes' }, { pos: -1 }, { pos: Infinity }, { rate: 3 }, { rate: 0.2 }, { rate: NaN }, { at: -5 }, { at: 1.5 }]) {
      expect(parseParty(JSON.stringify({ ...party(), ...off }))).toBeNull();
    }
    // YouTube's custom speed goes in hundredths, between its menu's steps.
    expect(parseParty(partyText(party({ rate: 1.1 })))?.rate).toBe(1.1);
    expect(parseParty('not json')).toBeNull();
    expect(parseParty('null')).toBeNull();
  });

  it('is the change made last, though another counts higher: a friend back after a while declares the party as it was then', () => {
    const old = party({ n: 7, by: ALICE, at: 1_000_000 });
    const started = party({ n: 1, by: BOB, at: 1_000_000 + 120_000, video: 'jNQXAC9IVRw' });
    expect(current([old, started])).toBe(started);
    expect(current([started, old])).toBe(started);
  });

  it('is the latest change anyone in it declares; of two made at once, the higher count\'s, then the greater key\'s', () => {
    const first = party({ n: 1 });
    const second = party({ n: 2, playing: false });
    expect(current([first, second])).toBe(second);
    expect(current([second, first])).toBe(second);
    expect(current([])).toBeNull();
    const mine = party({ n: 3, by: ALICE });
    const his = party({ n: 3, by: BOB });
    expect(later(his, mine)).toBe(true);
    expect(current([mine, his])).toBe(his);
    expect(current([his, mine])).toBe(his);
    // Declared again by a friend who took it, it is the same change.
    expect(sameChange(second, { ...second })).toBe(true);
    // A party started again by the same friend, after one ended: counted from 1 again, later.
    expect(sameChange(party({ n: 1 }), party({ n: 1, at: 2_000_000 }))).toBe(false);
    expect(sameChange(second, first)).toBe(false);
    expect(sameChange(null, null)).toBe(true);
    expect(sameChange(first, null)).toBe(false);
  });

  it('is further on by the time since, at its speed, while it plays; where it was while paused', () => {
    expect(positionAt(party(), 1_000_000 + 3000)).toBe(13);
    expect(positionAt(party({ rate: 2 }), 1_000_000 + 3000)).toBe(16);
    expect(positionAt(party({ playing: false }), 1_000_000 + 3000)).toBe(10);
    // A clock a little behind the one that made the change does not put it before where it was.
    expect(positionAt(party(), 1_000_000 - 500)).toBe(10);
  });

  it('takes a change of mine as one more than the newest I have seen, made by me now', () => {
    expect(change(null, BOB, 7, { hash: 'h'.repeat(43), video: 'dQw4w9WgXcQ', playing: true, pos: 0, rate: 1 })).toEqual({ n: 1, by: BOB, at: 7, hash: 'h'.repeat(43), video: 'dQw4w9WgXcQ', playing: true, pos: 0, rate: 1 });
    expect(change(party({ n: 41, at: 5 }), BOB, 8, { ...party(), playing: false, pos: -0.2 })).toMatchObject({ n: 42, by: BOB, at: 8, playing: false, pos: 0 });
    // My idea of the Room's clock a little behind the friend's who made the last change: mine still comes after it.
    const theirs = party({ n: 3, at: 2_000 });
    const mine = change(theirs, BOB, 1_900, { ...party(), playing: false });
    expect(mine.at).toBe(2_001);
    expect(later(mine, theirs)).toBe(true);
  });

  it('tells a seek from buffering: a jump back or ahead is one, falling behind while playing is not', () => {
    expect(jumped(10, 11, 1000, true, 1)).toBe(false); // played on
    expect(jumped(10, 10, 1000, true, 1)).toBe(false); // buffering: stood still
    expect(jumped(10, 10.2, 3000, true, 1)).toBe(false); // buffering for long
    expect(jumped(10, 85, 1000, true, 1)).toBe(true); // ahead
    expect(jumped(80, 10, 1000, true, 1)).toBe(true); // back
    expect(jumped(10, 12, 1000, true, 2)).toBe(false); // at twice the speed
    expect(jumped(10, 10, 1000, false, 1)).toBe(false);
    expect(jumped(10, 30, 1000, false, 1)).toBe(true); // sought while paused
  });

  it('while the app\'s seeks are under way, takes a time at one of them, or from before them, for theirs, and any other for the friend\'s', () => {
    // The app sent the player from 1 s to 2 s; runner log, 2026-11-15: the friend's seek to 85 s came meanwhile.
    const one = seekMore(null, 2, 1, 1000);
    expect(fromSeeking(one, 2.1, 1200, 1)).toBe(true); // its answer
    expect(fromSeeking(one, 3.5, 2000, 1)).toBe(true); // played on from there
    expect(fromSeeking(one, 1.1, 1100, 1)).toBe(true); // a report from before it
    expect(fromSeeking(one, 85.6, 1300, 1)).toBe(false); // the friend's
    // Two seeks before the first was answered (a friend pressed → twice): the first's answer is the app's too.
    const two = seekMore(seekMore(null, 15, 10, 1000), 20, 10.1, 1100);
    expect(two).toEqual({ to: [15, 20], from: 10, at: 1100 });
    expect(fromSeeking(two, 15, 1200, 1)).toBe(true);
    expect(fromSeeking(two, 20, 1300, 1)).toBe(true);
    expect(fromSeeking(two, 10.2, 1200, 1)).toBe(true);
    expect(fromSeeking(two, 60, 1300, 1)).toBe(false);
  });

  it('lets a playing player drift a little, a paused one hardly at all', () => {
    expect(driftAllowed(party())).toBeGreaterThan(1);
    expect(driftAllowed(party({ playing: false }))).toBeLessThan(0.5);
  });
});
