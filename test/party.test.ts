import { describe, expect, it } from 'vitest';
import { MAX_PARTY_BODY_BYTES, MAX_QUEUE, MAX_QUEUED_TITLE_BYTES, QUEUED_BY_LENGTH, asIs, change, current, driftAllowed, enqueue, fromSeeking, jumped, later, moveQueued, next, parseParty, partyText, positionAt, queuedTitle, sameChange, seekMore, type Party, type Queued } from '../src/core/party';
import { MAX_SEALED_PARTY_LENGTH, MAX_SEALED_PROFILE_LENGTH, MAX_VIEWERS } from '../src/core/protocol';
import { MAX_TURN_USERS, type SocketState } from '../src/core/room';

const ALICE = 'a'.repeat(87);
const BOB = 'b'.repeat(87);
const queued = (id: string, over: Partial<Queued> = {}): Queued => ({ id: id.padEnd(8, '-'), by: ALICE.slice(0, QUEUED_BY_LENGTH), hash: 'q'.repeat(43), video: 'jNQXAC9IVRw', title: 'Me at the zoo', ...over });
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
    // The card's title, for a friend who does not have the card: as long as a card's, written out the longest JSON can.
    const titled = party({ title: 'Rick Astley - Never Gonna Give You Up' });
    expect(parseParty(partyText(titled))).toEqual(titled);
    const longest = party({ n: Number.MAX_SAFE_INTEGER, pos: 99999.999, at: Number.MAX_SAFE_INTEGER, rate: 0.25, title: '\u0001'.repeat(100) });
    expect(parseParty(partyText(longest))).toEqual(longest);
    expect(new TextEncoder().encode(partyText(longest)).length).toBeLessThanOrEqual(MAX_PARTY_BODY_BYTES);
    for (const title of ['', 'x'.repeat(101), 7]) expect(parseParty(JSON.stringify({ ...party(), title }))).toBeNull();
    // One from an app before titles: none, and sealed as it was.
    expect(parseParty(partyText(party()))).not.toHaveProperty('title');
    expect(partyText(party())).not.toContain('title');
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
    expect(change(null, BOB, 7, { hash: 'h'.repeat(43), video: 'dQw4w9WgXcQ', playing: true, pos: 0, rate: 1 })).toEqual({ n: 1, by: BOB, at: 7, hash: 'h'.repeat(43), video: 'dQw4w9WgXcQ', playing: true, pos: 0, rate: 1, queue: [] });
    expect(change(party({ n: 41, at: 5 }), BOB, 8, { ...party(), playing: false, pos: -0.2 })).toMatchObject({ n: 42, by: BOB, at: 8, playing: false, pos: 0 });
    expect(change(party({ n: 1 }), BOB, 9, { ...party(), title: 'A title' }).title).toBe('A title');
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

  it('carries a queue it reads back, empty too, and nothing off; an app from before writes none', () => {
    const q = party({ queue: [queued('a'), queued('b', { title: undefined }), queued('a2', { video: 'dQw4w9WgXcQ', hash: 'h'.repeat(43) })] });
    expect(parseParty(partyText(q))).toEqual(q);
    expect(parseParty(partyText(party({ queue: [] })))).toEqual(party({ queue: [] }));
    expect(parseParty(partyText(party()))).not.toHaveProperty('queue');
    for (const off of [{ id: 'short' }, { by: ALICE }, { hash: 'x' }, { video: 'nope' }, { title: '' }, { title: 'x'.repeat(MAX_QUEUED_TITLE_BYTES + 1) }, { title: 'a\u0001b' }, { title: ' padded ' }]) {
      expect(parseParty(partyText(party({ queue: [queued('a', off as Partial<Queued>)] })))).toBeNull();
    }
    expect(parseParty(JSON.stringify({ ...party(), queue: 'none' }))).toBeNull();
    expect(parseParty(partyText(party({ queue: [queued('a'), queued('a', { title: 'Another' })] })))).toBeNull(); // the same id twice
    expect(parseParty(partyText(party({ queue: Array.from({ length: MAX_QUEUE + 1 }, (_, i) => queued(`q${i}`)) })))).toBeNull();
  });

  it('cuts a queued title to whole characters that fit, as JSON writes them, and leaves out what JSON writes longer', () => {
    expect(queuedTitle('Rick Astley - Never Gonna Give You Up')).toBe('Rick Astley - Never Gonna Give You Up');
    expect(queuedTitle(undefined)).toBeUndefined();
    expect(queuedTitle(' \u0001 ')).toBeUndefined();
    expect(queuedTitle('x'.repeat(200))).toBe('x'.repeat(MAX_QUEUED_TITLE_BYTES));
    expect(queuedTitle('日本'.repeat(40))).toBe('日本'.repeat(15)); // 3 bytes each
    expect(queuedTitle('🎉'.repeat(40))).toBe('🎉'.repeat(22)); // 4 bytes, never half of one
    expect(queuedTitle('"'.repeat(100))).toBe('"'.repeat(45)); // \" in JSON
    expect(queuedTitle('a\u0007b\uD800c')).toBe('a b c');
    for (const t of ['x'.repeat(200), '日本'.repeat(40), '🎉'.repeat(40), 'a\u0007b']) expect(queuedTitle(queuedTitle(t))).toBe(queuedTitle(t));
  });

  it('seals a full queue of the longest entries within its bound, and the longest sealed party fits a socket\'s attachment with the rest', () => {
    const longTitles = ['x', '日', '"', '🎉'].map((c) => queuedTitle(c.repeat(MAX_QUEUED_TITLE_BYTES))!);
    for (const title of longTitles) {
      const full = party({ n: Number.MAX_SAFE_INTEGER, pos: 99999.999, at: Number.MAX_SAFE_INTEGER, rate: 0.25, title: '\u0001'.repeat(100), queue: Array.from({ length: MAX_QUEUE }, (_, i) => queued(`q${i}`, { title })) });
      expect(parseParty(partyText(full))).toEqual(full);
      expect(new TextEncoder().encode(partyText(full)).length).toBeLessThanOrEqual(MAX_PARTY_BODY_BYTES);
    }
    // Everything the Room keeps of a socket, each at its longest (TURN usernames: Cloudflare's are hex, 128 at most here),
    // as workerd keeps it: V8's serialisation, at most 16384 bytes (measured with wrangler dev, 2026-11-17). Here as JSON,
    // which V8's is within a few bytes a field of (one byte a character, no quotes, a number in 9): a kilobyte to spare.
    const key = 'k'.repeat(87);
    const bucket = { tokens: 39.999999, at: Number.MAX_SAFE_INTEGER };
    const worst: SocketState = {
      stage: 'attached',
      person: { publicKey: key, fingerprint: 'ABCDEF', profile: 'p'.repeat(MAX_SEALED_PROFILE_LENGTH), role: 'participant', joinSeq: Number.MAX_SAFE_INTEGER, sharing: true, viewers: Array.from({ length: MAX_VIEWERS }, () => key), muted: true, party: 'P'.repeat(MAX_SEALED_PARTY_LENGTH), privateTexts: { key, sig: 's'.repeat(86) } },
      bucket, signalBucket: bucket, linkBucket: bucket, pieceBucket: bucket, fetchBucket: bucket,
      linkIceAt: Number.MAX_SAFE_INTEGER, syncAt: Number.MAX_SAFE_INTEGER, forgetAt: Number.MAX_SAFE_INTEGER, attachedAt: Number.MAX_SAFE_INTEGER,
      turnUsers: Array.from({ length: MAX_TURN_USERS }, () => 'f'.repeat(128)), joins: Number.MAX_SAFE_INTEGER, telemetry: true,
    };
    expect(JSON.stringify(worst).length).toBeLessThan(16384 - 1024);
  });

  it('takes, of two copies of the same change, the one with a queue, the same one for everyone', () => {
    const made = party({ n: 5, queue: [queued('a')] });
    const { queue: _, ...stripped } = made; // as an app from before declares it again
    expect(current([stripped, made])).toBe(made);
    expect(current([made, stripped])).toBe(made);
    const other = { ...made, queue: [queued('b')] };
    expect(current([made, other])).toBe(current([other, made]));
    // A queue carried on stale beside one carried on as it is: the longer.
    const longer = { ...made, queue: [queued('a'), queued('b')] };
    expect(current([made, longer])).toBe(longer);
    expect(current([longer, made])).toBe(longer);
    const empty = { ...made, queue: [] };
    expect(current([empty, made])).toBe(made);
    // A later change counts, queue or none.
    const after = party({ n: 6, at: made.at + 1 });
    expect(current([made, after])).toBe(after);
  });

  it('puts videos in the queue first or last, moves and plays them in order', () => {
    const [a, b, c] = [queued('a'), queued('b'), queued('c')];
    expect(enqueue([a], b, false)).toEqual([a, b]);
    expect(enqueue([a], b, true)).toEqual([b, a]);
    const full = Array.from({ length: MAX_QUEUE }, (_, i) => queued(`q${i}`));
    expect(enqueue(full, a, true)).toBeNull();
    expect(moveQueued([a, b, c], c.id, -1)).toEqual([a, c, b]);
    expect(moveQueued([a, b, c], a.id, 1)).toEqual([b, a, c]);
    expect(moveQueued([a, b, c], a.id, -1)).toEqual([a, b, c]);
    expect(moveQueued([a, b, c], c.id, 1)).toEqual([a, b, c]);
    expect(moveQueued([a, b, c], 'gone----', 1)).toEqual([a, b, c]);
    // The next goes on from its start at the party's speed, out of the queue; its title my card's where I have it.
    const p = party({ rate: 1.5, playing: false, queue: [a, b] });
    expect(next(p, true, () => undefined)).toEqual({ hash: a.hash, video: a.video, title: a.title, playing: true, pos: 0, rate: 1.5, queue: [b] });
    expect(next(p, false, () => 'Me at the zoo, the whole title')).toMatchObject({ playing: false, title: 'Me at the zoo, the whole title' });
    expect(next(party({ queue: [] }), true, () => undefined)).toBeNull();
    expect(next(party(), true, () => undefined)).toBeNull();
    // The party as it is, to change its queue alone: where it is by now.
    expect(asIs(party({ queue: [a] }), 1_000_000 + 2000)).toEqual({ hash: 'h'.repeat(43), video: 'dQw4w9WgXcQ', title: undefined, playing: true, pos: 12, rate: 1, queue: [a] });
  });
});
