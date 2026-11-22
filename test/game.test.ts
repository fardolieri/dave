import { describe, expect, it } from 'vitest';
import { MAX_GAME_BODY_BYTES, current, currents, gameLinkId, gameOfLink, gameText, parseGame, sameGame, type Game } from '../src/core/game';
import {
  BALL_RADIUS, COUNT_MS, DASH_COOLDOWN_MS, DASH_SPEED, FLOE_MID, FLOE_START, MAX_ROLL, OVER_MS, SHRINK_END_MS, SHRINK_MID_MS, SUNK_Y,
  advance, ahead, ballAt, ballFrame, bonk, dash, hitFrame, knocked, firstRound, floeRadius, leaderOf, parseFrame, roll, roundFrame, roundOf, spawnAt, steer, whoOf,
  type Ball, type Counted, type Round,
} from '../src/core/bonk';

const game = (over: Partial<Game> = {}): Game => ({ game: 'bonk', id: 'abcdEFGH', at: 1_000_000, ...over });

describe('a game in the call (core/game.ts)', () => {
  it('reads back what it seals, within its bound, and nothing off or unknown', () => {
    const g = game({ at: Number.MAX_SAFE_INTEGER });
    expect(parseGame(gameText(g))).toEqual(g);
    expect(new TextEncoder().encode(gameText(g)).length).toBeLessThanOrEqual(MAX_GAME_BODY_BYTES);
    for (const off of [{ game: 'chess' }, { id: 'short' }, { id: 'abcdEFG!' }, { at: -1 }, { at: 1.5 }, { at: '1' }]) expect(parseGame(JSON.stringify({ ...game(), ...off }))).toBeNull();
    expect(parseGame('not json')).toBeNull();
    expect(parseGame('null')).toBeNull();
  });

  it('is the one most play, then the one started first, then the smaller id, whatever order the players are listed in', () => {
    const first = game({ id: 'zzzzzzzz', at: 5 });
    const second = game({ id: 'aaaaaaaa', at: 6 });
    expect(current([second, first])).toBe(first);
    expect(current([first, second])).toBe(first);
    const tie = game({ id: 'aaaaaaaa', at: 5 });
    expect(current([first, tie])).toBe(tie);
    expect(current([tie, first])).toBe(tie);
    expect(current([])).toBeNull();
    // A friend back from a while away, with a game that ended meanwhile, does not pull the others into it.
    const since = game({ id: 'bbbbbbbb', at: 9 });
    expect(current([first, since, { ...since }])).toEqual(since);
    expect(current([since, first, { ...since }])).toEqual(since);
    expect(sameGame(first, { ...first })).toBe(true);
    expect(sameGame(first, null)).toBe(false);
    expect(sameGame(null, null)).toBe(true);
  });

  it('goes on side by side with a game of another kind, but never with another of its own', () => {
    const bonk = game({ id: 'bbbbbbbb', at: 7 });
    const clink = game({ game: 'clink', id: 'cccccccc', at: 5 });
    const later = game({ id: 'aaaaaaaa', at: 8 });
    // Each kind as `current` picks it, in the order the games are named, whatever order the players are listed in.
    expect(currents([bonk, later, clink])).toEqual([bonk, clink]);
    expect(currents([later, clink, bonk])).toEqual([bonk, clink]);
    // More play the later Bonk: it is the call's Bonk, and the Clink goes on beside it.
    expect(currents([bonk, later, { ...later }, clink])).toEqual([later, clink]);
    const skid = game({ game: 'skid', id: 'aaaaaaaa', at: 9 });
    expect(currents([clink, skid])).toEqual([skid, clink]);
    expect(currents([])).toEqual([]);
  });

  it('names its links apart from file links, whose names are hex', () => {
    expect(gameOfLink(gameLinkId(game()))).toBe('abcdEFGH');
    expect(gameLinkId(game())).toMatch(/^[A-Za-z0-9_-]{1,32}$/); // a link's name, as the Room takes it (core/protocol.ts)
    expect(gameOfLink('0123456789abcdef01')).toBeNull();
    expect(gameOfLink('game-short')).toBeNull();
  });
});

const ALICE = 'A'.repeat(87);
const BOB = 'B'.repeat(87);
const CAROL = 'C'.repeat(87);
const [A, B, C] = [whoOf(ALICE), whoOf(BOB), whoOf(CAROL)];
const at = (r: Round, ms: number) => r.since + ms;
const here = (...c: Counted[]) => c;

describe('Bonk, a ball on the floe (core/bonk.ts)', () => {
  it('rolls the way it is steered, no faster than it rolls by itself, and slides on when let go', () => {
    let b = ballAt(0, 0);
    for (let i = 0; i < 300; i++) b = roll(b, { x: 1, z: 0 }, 1 / 60, FLOE_START * 10);
    expect(b.vx).toBeGreaterThan(MAX_ROLL * 0.85);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThanOrEqual(MAX_ROLL);
    const let_go = roll(b, { x: 0, z: 0 }, 1 / 60, FLOE_START * 10);
    expect(let_go.vx).toBeLessThan(b.vx);
    expect(let_go.vx).toBeGreaterThan(b.vx * 0.95);
    expect(steer(1, 1).x).toBeCloseTo(Math.SQRT1_2);
    expect(steer(0.3, 0)).toEqual({ x: 0.3, z: 0 });
  });

  it('falls off past the edge, out of the round, and sinks', () => {
    let b = roll({ ...ballAt(FLOE_START - 0.01, 0), vx: 5 }, { x: 0, z: 0 }, 0.1, FLOE_START);
    expect(b.alive).toBe(false);
    for (let i = 0; i < 200; i++) b = roll(b, { x: -1, z: 0 }, 1 / 60, FLOE_START);
    expect(b.y).toBe(SUNK_Y);
    expect(b.alive).toBe(false);
  });

  it('dashes in the direction steered, else straight on, and not again before its cooldown', () => {
    const b = dash(ballAt(0, 0), { x: 0, z: -1 }, 10_000);
    expect(b.vz).toBeCloseTo(-DASH_SPEED);
    expect(dash(b, { x: 1, z: 0 }, 10_000 + DASH_COOLDOWN_MS - 1)).toBe(b);
    expect(dash(b, { x: 1, z: 0 }, 10_000 + DASH_COOLDOWN_MS).vx).toBeCloseTo(DASH_SPEED);
    expect(dash({ ...ballAt(0, 0), vx: 2 }, { x: 0, z: 0 }, 0).vx).toBeCloseTo(DASH_SPEED);
    const still = ballAt(0, 0);
    expect(dash(still, { x: 0, z: 0 }, 0)).toBe(still);
  });

  it('bonks: the ball run into takes the speed of the one that ran into it, and more, on both sides', () => {
    const runner: Ball = { ...ballAt(0, 0), vx: 6 };
    const standing: Ball = ballAt(2 * BALL_RADIUS - 0.2, 0);
    const mine = bonk(runner, standing);
    const theirs = bonk(standing, runner);
    expect(mine.hit).toBeCloseTo(6);
    expect(theirs.hit).toBeCloseTo(6);
    expect(theirs.ball.vx).toBeGreaterThan(6); // sent flying
    expect(mine.ball.vx).toBeLessThan(0); // bounced back a little
    // Momentum along the line is kept, and the bonk adds to the gap between them.
    expect(mine.ball.vx + theirs.ball.vx).toBeCloseTo(6);
    // Pushed apart, each half of the overlap.
    expect(theirs.ball.x - mine.ball.x).toBeCloseTo(2 * BALL_RADIUS);
    // Once apart they leave each other be; out of the round, too.
    expect(bonk(mine.ball, theirs.ball).hit).toBe(0);
    expect(bonk(runner, { ...standing, alive: false }).ball).toBe(runner);
    expect(bonk(runner, ballAt(5, 0)).ball).toBe(runner);
  });

  it('gives the ball run into, by its knock, what its own app would have given it', () => {
    // The runner's app bounced it off at once, and says where it is: touching, going away. The other app, from there,
    // sees no bonk at all, which is why the runner's sends the knock.
    const runner: Ball = { ...ballAt(0, 0), vx: 6, vz: 1 };
    const standing: Ball = { ...ballAt(2 * BALL_RADIUS - 0.2, 0.1), vx: -0.5 };
    const mine = bonk(runner, standing);
    expect(bonk(standing, { ...mine.ball, alive: true }).hit).toBe(0);
    const given = knocked(standing, mine.knock);
    const own = bonk(standing, runner).ball;
    expect(given.vx).toBeCloseTo(own.vx);
    expect(given.vz).toBeCloseTo(own.vz);
    expect(knocked({ ...standing, alive: false }, mine.knock).vx).toBe(-0.5);
    expect(bonk(runner, ballAt(5, 0)).knock).toEqual({ vx: 0, vz: 0 });
  });

  it('puts every player round a ring on the floe, the same for everyone, none on another', () => {
    for (const count of [2, 3, 5, 8]) {
      const spots = Array.from({ length: count }, (_, i) => spawnAt(i, count));
      for (const s of spots) expect(Math.hypot(s.x, s.z)).toBeLessThan(FLOE_START - BALL_RADIUS);
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.z - spots[j]!.z)).toBeGreaterThan(2 * BALL_RADIUS);
    }
  });

  it('shrinks the floe while a round plays, to nothing at last, so every round ends', () => {
    expect(floeRadius('wait', 1e9)).toBe(FLOE_START);
    expect(floeRadius('count', 0)).toBe(FLOE_START);
    expect(floeRadius('play', 0)).toBe(FLOE_START);
    expect(floeRadius('play', SHRINK_MID_MS)).toBeCloseTo(FLOE_MID);
    expect(floeRadius('play', SHRINK_END_MS)).toBe(0);
    expect(floeRadius('play', SHRINK_END_MS * 2)).toBe(0);
    expect(floeRadius('over', 0, 4.5)).toBe(4.5); // as the round left it
    let last = Infinity;
    for (let ms = 0; ms <= SHRINK_END_MS; ms += 500) { const r = floeRadius('play', ms); expect(r).toBeLessThanOrEqual(last); last = r; }
  });

  it('carries on where another player was going, a quarter of a second at most', () => {
    const s = { x: 0, z: 0, vx: 4, vz: 0, alive: true };
    expect(ahead(s, 100).x).toBeCloseTo(0.4);
    expect(ahead(s, 5000).x).toBeCloseTo(1);
    expect(ahead(s, -50).x).toBe(0);
  });
});

describe('Bonk, the rounds (core/bonk.ts)', () => {
  it('waits for a second player, counts down, plays until one is left, shows the winner, and goes again', () => {
    let r = firstRound(0);
    expect(advance(r, 10_000, here({ who: A, n: 0, known: 0, alive: true }))).toBe(r);
    r = advance(r, 10_000, here({ who: B, n: 0, known: 0, alive: true }, { who: A, n: 0, known: 0, alive: true }));
    expect(r).toMatchObject({ n: 1, phase: 'count', players: [A, B] });
    expect(advance(r, at(r, COUNT_MS - 1), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }))).toBe(r);
    r = advance(r, at(r, COUNT_MS), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }));
    expect(r.phase).toBe('play');
    expect(advance(r, at(r, 30_000), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }))).toBe(r);
    r = advance(r, at(r, 31_000), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: false }));
    expect(r).toMatchObject({ phase: 'over', winner: A, wins: { [A]: 1 } });
    expect(advance(r, at(r, OVER_MS - 1), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }))).toBe(r);
    r = advance(r, at(r, OVER_MS), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }, { who: C, n: 0, known: 0, alive: true }));
    expect(r).toMatchObject({ n: 2, phase: 'count', players: [A, B, C], winner: null, wins: { [A]: 1 } });
  });

  it('counts a player gone from the game as fallen, one not yet in the round as standing, and a draw for nobody', () => {
    let r: Round = { ...firstRound(0), n: 3, phase: 'play', players: [A, B, C] };
    // C's app has not taken round 3 yet: still in it.
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: true }, { who: B, n: 3, known: 3, alive: false }, { who: C, n: 2, known: 2, alive: false }))).toBe(r);
    // C reloaded, and watches round 3: out of it, and A wins; with B back too, the round still ends.
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: true }, { who: B, n: 3, known: 3, alive: false }, { who: C, n: 0, known: 3, alive: false }))).toMatchObject({ phase: 'over', winner: A });
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: false }, { who: B, n: 0, known: 3, alive: false }, { who: C, n: 0, known: 3, alive: false }))).toMatchObject({ phase: 'over', winner: null });
    // C left the game: A stands alone.
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: true }, { who: B, n: 3, known: 3, alive: false }))).toMatchObject({ phase: 'over', winner: A });
    // The last two fell together.
    r = advance(r, 1000, here({ who: A, n: 3, known: 3, alive: false }, { who: B, n: 3, known: 3, alive: false }, { who: C, n: 3, known: 3, alive: false }));
    expect(r).toMatchObject({ phase: 'over', winner: null, wins: {} });
    // Alone after it: the wait.
    expect(advance(r, at(r, OVER_MS), here({ who: A, n: 3, known: 3, alive: true }))).toMatchObject({ phase: 'wait', players: [] });
  });

  it('goes back to the wait when the second player leaves during the countdown', () => {
    const r = advance(firstRound(0), 0, here({ who: A, n: 0, known: 0, alive: true }, { who: B, n: 0, known: 0, alive: true }));
    expect(advance(r, 1000, here({ who: A, n: 1, known: 1, alive: true }))).toMatchObject({ phase: 'wait', n: 1 });
  });

  it('is led by who knows the newest round, then by the smallest key: one just come in leads nobody yet', () => {
    expect(leaderOf([{ key: BOB, n: 4 }, { key: CAROL, n: 4 }, { key: ALICE, n: 0 }])).toBe(BOB);
    expect(leaderOf([{ key: BOB, n: 4 }, { key: CAROL, n: 4 }, { key: ALICE, n: 4 }])).toBe(ALICE);
    expect(leaderOf([])).toBeNull();
  });
});

describe('Bonk, on the wire (core/bonk.ts)', () => {
  it('reads back a ball and a round, and a follower takes the round where the leader has it', () => {
    const b = ballFrame({ ...ballAt(1.23456, -2), vx: 3.333, alive: false, y: -1 }, 4, 5, true);
    expect(parseFrame(JSON.stringify(b))).toEqual({ k: 'b', r: 4, n: 5, x: 1.23, z: -2, vx: 3.33, vz: 0, y: -1, a: false, d: true });
    const r: Round = { n: 2, phase: 'play', since: 1000, players: [A, B], winner: null, wins: { [A]: 2 } };
    const f = roundFrame(r, 1500, 7);
    expect(parseFrame(JSON.stringify(f))).toEqual(f);
    expect(roundOf(f, 90_000)).toEqual({ ...r, since: 89_500 });
    const h = hitFrame(BOB, { vx: 7.0711, vz: -1 }, 6.5);
    expect(parseFrame(JSON.stringify(h))).toEqual({ k: 'h', to: B, vx: 7.07, vz: -1, hit: 6.5 });
  });

  it('drops anything off', () => {
    const good = { k: 'r', q: 1, n: 1, ph: 'play', t: 0, ps: [A], w: null, wins: [[A, 1]] };
    for (const off of [{ ph: 'dance' }, { n: -1 }, { t: 1.5 }, { ps: ['x'] }, { ps: Array(17).fill(A) }, { q: 0.5 }, { w: 'x' }, { wins: [[A, -1]] }, { wins: [[A]] }]) {
      expect(parseFrame(JSON.stringify({ ...good, ...off }))).toBeNull();
    }
    const ball = { k: 'b', r: 0, n: 0, x: 0, z: 0, vx: 0, vz: 0, y: 0, a: true, d: false };
    expect(parseFrame(JSON.stringify(ball))).toEqual(ball);
    for (const off of [{ x: 1e9 }, { x: 'NaN' }, { a: 1 }, { r: 0.5 }, { n: -1 }, { k: 'x' }]) expect(parseFrame(JSON.stringify({ ...ball, ...off }))).toBeNull();
    const hit = { k: 'h', to: A, vx: 1, vz: 1, hit: 2 };
    expect(parseFrame(JSON.stringify(hit))).toEqual(hit);
    for (const off of [{ to: 'x' }, { vx: 1000 }, { hit: -1 }, { vz: null }]) expect(parseFrame(JSON.stringify({ ...hit, ...off }))).toBeNull();
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame(new ArrayBuffer(4))).toBeNull();
    expect(parseFrame('x'.repeat(5000))).toBeNull();
  });
});
