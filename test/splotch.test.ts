import { describe, expect, it } from 'vitest';
import {
  BLOB_RADIUS, BOARD, COUNT_MS, HALF, OVER_MS, PLAY_MS, SPEED, SPLAT_COOLDOWN_MS, SPLAT_RADIUS,
  advance, blobAt, emptyBoard, move, paintDisc, paintFrame, paintPath, parseFrame, roundLeader, secondsLeft, splat, startAt, tally, winnerOf, type Counted,
} from '../src/core/splotch';
import { firstRound, roundFrame, roundOf, whoOf, type Round } from '../src/core/rounds';

const [A, B, C] = ['A', 'B', 'C'].map((c) => whoOf(c.repeat(87))) as [string, string, string];
const here = (...c: Counted[]) => c;
const at = (r: Round, ms: number) => r.since + ms;

describe('Splotch, a blob on the board (core/splotch.ts)', () => {
  it('goes the way it is steered at its speed, stops when let go, and stays on the board', () => {
    let b = blobAt(0, 0);
    for (let i = 0; i < 60; i++) b = move(b, { x: 1, z: 0 }, 1 / 60);
    expect(b.vx).toBeCloseTo(SPEED, 1);
    for (let i = 0; i < 30; i++) b = move(b, { x: 0, z: 0 }, 1 / 60);
    expect(Math.abs(b.vx)).toBeLessThan(0.1);
    for (let i = 0; i < 600; i++) b = move(b, { x: -1, z: 1 }, 1 / 60);
    expect(b.x).toBe(-(HALF - BLOB_RADIUS));
    expect(b.z).toBe(HALF - BLOB_RADIUS);
    expect(b.vx).toBe(0);
  });

  it('splats now and then, each named later than the one before, even by a clock that went back', () => {
    const wall = 1_763_700_000_000;
    const b = splat(blobAt(0, 0), 10_000, wall);
    expect(b.splat).toBe(wall);
    expect(splat(b, 10_000 + SPLAT_COOLDOWN_MS - 1, wall + 5000)).toBe(b);
    expect(splat(b, 10_000 + SPLAT_COOLDOWN_MS, wall + 5000).splat).toBe(wall + 5000);
    expect(splat(b, 10_000 + SPLAT_COOLDOWN_MS, wall - 60_000).splat).toBe(wall + 1);
  });

  it('starts every player round a ring on the board, apart', () => {
    for (const count of [2, 3, 6, 8]) {
      const spots = Array.from({ length: count }, (_, i) => startAt(i, count));
      for (const s of spots) expect(Math.max(Math.abs(s.x), Math.abs(s.z))).toBeLessThan(HALF - BLOB_RADIUS);
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z)).toBeGreaterThan(2 * BLOB_RADIUS);
    }
  });
});

describe('Splotch, the board (core/splotch.ts)', () => {
  it('paints a trail with no gaps however far the blob went between two frames, over anyone else\'s', () => {
    const board = emptyBoard();
    expect(board).toHaveLength(BOARD * BOARD);
    paintPath(board, A, { x: -10, z: 0.5 }, { x: 10, z: 0.5 });
    // Every tile along the row the trail went through is A's.
    for (let tx = 2; tx < BOARD - 2; tx++) expect(board[(0.5 + HALF - 0.5) * BOARD + tx]).toBe(A);
    const before = tally(board)[A]!;
    const changed = paintPath(board, B, { x: 0.5, z: -10 }, { x: 0.5, z: 10 });
    expect(changed.length).toBeGreaterThan(15);
    expect(tally(board)[A]).toBeLessThan(before);
    expect(board[(0.5 + HALF - 0.5) * BOARD + 12]).toBe(B);
    // Painting what is mine already changes nothing.
    expect(paintPath(board, B, { x: 0.5, z: -10 }, { x: 0.5, z: 10 })).toEqual([]);
  });

  it('splats a round patch, kept on the board at its edge', () => {
    const board = emptyBoard();
    const n = paintDisc(board, C, 0, 0, SPLAT_RADIUS).length;
    expect(n).toBeGreaterThan(Math.PI * (SPLAT_RADIUS - 0.75) ** 2);
    expect(n).toBeLessThan(Math.PI * (SPLAT_RADIUS + 0.75) ** 2);
    expect(paintDisc(emptyBoard(), C, HALF, HALF, SPLAT_RADIUS).length).toBeGreaterThan(0);
    expect(paintDisc(emptyBoard(), C, HALF + 50, 0, SPLAT_RADIUS)).toEqual([]);
  });

  it('is won by whoever has the most, by nobody on a tie', () => {
    expect(winnerOf({ [A]: 30, [B]: 20 })).toBe(A);
    expect(winnerOf({ [A]: 30, [B]: 30 })).toBeNull();
    expect(winnerOf({ [A]: 30, [B]: 30, [C]: 31 })).toBe(C);
    expect(winnerOf({})).toBeNull();
  });
});

describe('Splotch, the rounds (core/splotch.ts)', () => {
  const board = emptyBoard();
  paintDisc(board, A, -5, -5, 3);
  paintDisc(board, B, 5, 5, 2);

  it('waits for a second player, counts down, plays for its time, counts the leader\'s board, and goes again', () => {
    let r = firstRound(0);
    expect(advance(r, 1000, here({ who: A, n: 0, known: 0 }), () => board)).toBe(r);
    r = advance(r, 1000, here({ who: B, n: 0, known: 0 }, { who: A, n: 0, known: 0 }), () => board);
    expect(r).toMatchObject({ n: 1, phase: 'count', players: [A, B] });
    const two = here({ who: A, n: 1, known: 1 }, { who: B, n: 1, known: 1 });
    r = advance(r, at(r, COUNT_MS), two, () => board);
    expect(r.phase).toBe('play');
    expect(advance(r, at(r, PLAY_MS - 1), two, () => board)).toBe(r);
    r = advance(r, at(r, PLAY_MS), two, () => board);
    expect(r).toMatchObject({ phase: 'over', winner: A, wins: { [A]: 1 }, scores: tally(board) });
    expect(advance(r, at(r, OVER_MS - 1), two, () => board)).toBe(r);
    r = advance(r, at(r, OVER_MS), two, () => board);
    expect(r).toMatchObject({ n: 2, phase: 'count', winner: null, wins: { [A]: 1 } });
    expect(r.scores).toBeUndefined();
  });

  it('ends early when only one player is left in it; one not yet in it, or watching, counts as such', () => {
    const r: Round = { ...firstRound(0), n: 3, phase: 'play', players: [A, B] };
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3 }, { who: B, n: 2, known: 2 }), () => board)).toBe(r);
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3 }, { who: B, n: 0, known: 3 }), () => board)).toMatchObject({ phase: 'over' });
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3 }), () => board)).toMatchObject({ phase: 'over' });
  });

  it('is led, while a round plays, by one who plays it: a friend who came in later has a board that missed the start', () => {
    const r: Round = { ...firstRound(0), n: 3, phase: 'play', players: [B, C] };
    // Alice has the smallest key and knows round 3, but only watches it.
    const all = [{ key: 'A', known: 3, playing: 0 }, { key: 'B', known: 3, playing: 3 }, { key: 'C', known: 3, playing: 3 }];
    expect(roundLeader(r, all)).toBe('B');
    // Between rounds, and should no player of it be left, anyone.
    expect(roundLeader({ ...r, phase: 'over' }, all)).toBe('A');
    expect(roundLeader(r, [all[0]!])).toBe('A');
    expect(roundLeader({ ...r, phase: 'wait' }, all)).toBe('A');
  });

  it('counts down the seconds of the play', () => {
    expect(secondsLeft('play', 0)).toBe(PLAY_MS / 1000);
    expect(secondsLeft('play', PLAY_MS - 1)).toBe(1);
    expect(secondsLeft('play', PLAY_MS + 5)).toBe(0);
    expect(secondsLeft('wait', 0)).toBe(0);
  });
});

describe('Splotch, on the wire (core/splotch.ts)', () => {
  it('reads back a blob and a round with its score, and drops anything off', () => {
    const f = paintFrame({ ...blobAt(1.234, -2), vx: 3.333, splat: 1_763_700_000_000 }, 2, 3);
    expect(parseFrame(JSON.stringify(f))).toEqual({ k: 'p', r: 2, n: 3, x: 1.23, z: -2, vx: 3.33, vz: 0, s: 1_763_700_000_000 });
    for (const off of [{ x: 100 }, { s: -1 }, { s: 1.5 }, { n: 'x' }, { k: 'q' }]) expect(parseFrame(JSON.stringify({ ...f, ...off }))).toBeNull();
    const r: Round = { n: 2, phase: 'over', since: 1000, players: [A, B], winner: A, wins: { [A]: 1 }, scores: { [A]: 40, [B]: 12 } };
    const rf = roundFrame(r, 1500, 9);
    expect(parseFrame(JSON.stringify(rf))).toEqual(rf);
    expect(roundOf(rf, 10_000)).toEqual({ ...r, since: 9500 });
    expect(parseFrame(JSON.stringify({ ...rf, sc: [[A, -1]] }))).toBeNull();
    expect(parseFrame('[1]')).toBeNull();
  });
});
