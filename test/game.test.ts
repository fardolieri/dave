import { describe, expect, it } from 'vitest';
import { MAX_GAME_BODY_BYTES, current, currents, gameLinkId, gameOfLink, gameText, parseGame, sameGame, type Game } from '../src/core/game';
import {
  BALL_RADIUS, COUNT_MS, GUST_ACCEL, GUST_EVERY_MS, GUST_MS, TIE_MS, DASH_COOLDOWN_MS, DASH_SPEED, DROP_PLAY_MS, DROP_WINS, DROP_Y, FAST, FELT_HIT, FLOE_MID, FLOE_START, GIGA_LOW, HEAVY_MASS, ITEM_EVERY, PLAIN, GIGA_MOST, GIGA_TOP, SKY_TOP, MAX_ROLL, OVER_MS, SHRINK_END_MS, SHRINK_MID_MS, SUNK_Y,
  advance, ahead, ask, canBlow, gust, gustFrame, windAt, ballAt, ballFrame, bonk, canDash, dash, dropDue, dropIn, dropped, dropsLeft, effectsOf, fastFrom, firstStage, giga, gigaPower, gigaTier, gone, hitFrame, itemFrame, itemOf, movesOf, playClock, pushFrame, speedAt, stageFrame, stageOf, stageOfFrame, touched, knocked, toward, firstRound, floeRadius, leaderOf, parseFrame, roll, roundFrame, roundOf, spawnAt, steer, whoOf,
  type Ball, type Counted, type Led, type Round,
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

  it('is blown by the wind past the speed it rolls by itself, and gusts blown at once add up', () => {
    const g = gust({ x: 3, z: 4 }, 1000)!;
    expect(g).toEqual({ x: 0.6, z: 0.8, until: 1000 + GUST_MS });
    expect(gust({ x: 0.01, z: 0 }, 1000)).toBeNull();
    // Two the same way, and a third against them: what blows is one, until each ends.
    const w = { x: 1, z: 0 };
    expect(windAt([{ ...w, until: 2000 }, { ...w, until: 3000 }], 1000)).toEqual({ x: 2 * GUST_ACCEL, z: 0 });
    expect(windAt([{ ...w, until: 2000 }, { ...w, until: 3000 }, { x: -1, z: 0, until: 3000 }], 1000)).toEqual({ x: GUST_ACCEL, z: 0 });
    expect(windAt([{ ...w, until: 2000 }, { ...w, until: 3000 }], 2000)).toEqual({ x: GUST_ACCEL, z: 0 });
    expect(windAt([], 0)).toEqual({ x: 0, z: 0 });
    // A ball rolled at its top speed, the wind behind it: on faster than it rolls by itself; two gusts, faster still.
    const run = (wind: { x: number; z: number }) => { let b: Ball = { ...ballAt(0, 0), vx: MAX_ROLL }; for (let i = 0; i < 60; i++) b = roll(b, { x: 1, z: 0 }, 1 / 60, FLOE_START * 10, PLAIN, wind); return b; };
    const none = run({ x: 0, z: 0 }), one = run({ x: GUST_ACCEL, z: 0 }), two = run({ x: 2 * GUST_ACCEL, z: 0 });
    expect(none.vx).toBeLessThanOrEqual(MAX_ROLL);
    expect(one.vx).toBeGreaterThan(MAX_ROLL + 0.5);
    expect(two.vx).toBeGreaterThan(one.vx + 3);
    // One left standing still is blown some way across the floe by a gust, and on as far again on the ice after it.
    let still = ballAt(0, 0);
    for (let i = 0; i < (GUST_MS / 1000) * 60; i++) still = roll(still, { x: 0, z: 0 }, 1 / 60, FLOE_START * 10, PLAIN, { x: 0, z: GUST_ACCEL });
    expect(still.z).toBeGreaterThan(5);
    expect(still.vz).toBeGreaterThan(5);
    // Rolled against one gust it still gets on, slowly; against two it is blown back.
    const against = (n: number) => { let b = ballAt(0, 0); for (let i = 0; i < 90; i++) b = roll(b, { x: 1, z: 0 }, 1 / 60, FLOE_START * 10, PLAIN, { x: -n * GUST_ACCEL, z: 0 }); return b.x; };
    expect(against(1)).toBeGreaterThan(0);
    expect(against(2)).toBeLessThan(0);
    // Nobody blows a ball up in the air, nor one in the sea.
    const up: Ball = { ...ballAt(0, 0), y: 3, vy: 5 };
    expect(roll(up, { x: 0, z: 0 }, 0.1, FLOE_START, PLAIN, { x: 50, z: 0 }).vx).toBe(0);
    // Once out of a round, as often as GUST_EVERY_MS.
    expect(canBlow(-Infinity, 0)).toBe(true);
    expect(canBlow(5000, 5000 + GUST_EVERY_MS - 1)).toBe(false);
    expect(canBlow(5000, 5000 + GUST_EVERY_MS)).toBe(true);
  });

  it('rolls toward a spot held, full on from afar, and brakes to stop on it', () => {
    expect(toward(ballAt(0, 0), { x: 0, z: -8 })).toEqual({ x: 0, z: -1 });
    const far = toward(ballAt(1, 1), { x: 7, z: 9 });
    expect(Math.hypot(far.x, far.z)).toBeCloseTo(1);
    expect(far.x / far.z).toBeCloseTo(6 / 8);
    expect(toward(ballAt(2, 2), { x: 2, z: 2 })).toEqual({ x: 0, z: 0 });
    // Going fast at the spot, close to it: it brakes.
    expect(toward({ ...ballAt(0, 0), vx: 7 }, { x: 0.5, z: 0 }).x).toBeLessThan(-0.9);
    // Held there, a ball sliding the other way comes back to it, and stays.
    let b: Ball = { ...ballAt(-4, 0), vz: 5 };
    for (let i = 0; i < 60 * 4; i++) b = roll(b, toward(b, { x: 3, z: 2 }), 1 / 60, FLOE_START);
    expect(Math.hypot(b.x - 3, b.z - 2)).toBeLessThan(0.3);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(0.5);
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
    expect(bonk(runner, ballAt(5, 0)).knock).toEqual({ vx: 0, vz: 0, up: 0 });
  });

  it('drops a mystery ball roughly every hundred bonks, holding any item as likely; a giga is mostly a little harder, now and then far harder, with no top', () => {
    expect(dropIn(0)).toBe(1);
    expect(dropIn(0.999_999)).toBe(2 * ITEM_EVERY - 1);
    const waits = Array.from({ length: 1000 }, (_, i) => dropIn((i + 0.5) / 1000));
    expect(waits.reduce((a, b) => a + b, 0) / waits.length).toBeCloseTo(ITEM_EVERY, 0);
    expect([0, 0.3, 0.6, 0.9, 0.999_999].map(itemOf)).toEqual(['giga', 'heavy', 'handling', 'fast', 'fast']);
    expect(gigaPower(0)).toBe(GIGA_LOW);
    expect(gigaPower(0.5)).toBeCloseTo(3.17, 2);
    // A hundred times or more, one giga in some 350; a thousand, one in some 11,000; and on.
    expect(gigaPower(1 - 1 / 350)).toBeCloseTo(100, -1);
    expect(gigaPower(1 - 1 / 11_000)).toBeGreaterThan(900);
    expect(gigaPower(1 - 1e-12)).toBe(GIGA_MOST);
    // How mighty they look, of 100,000 evenly spread.
    const tiers = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 100_000; i++) tiers[gigaTier(gigaPower((i + 0.5) / 100_000))]! += 1;
    expect(tiers.map((n) => Math.round(n / 100))).toEqual([454, 292, 164, 67, 20, 3]);
    expect(gigaTier(0)).toBe(-1);
  });

  it('bonks giga: the giga ball\'s bonk is that much harder on the other, whoever ran into whom, and spent', () => {
    const runner: Ball = { ...ballAt(0, 0), vx: 6 };
    const standing: Ball = ballAt(2 * BALL_RADIUS - 0.2, 0);
    const plain = bonk(runner, standing);
    expect(plain.spent).toEqual({ mine: 0, theirs: 0 });
    expect(plain.knock.up).toBe(0);
    // The runner is giga, 3 times: its knock is 3 times as big, and throws a little up; its own bounce is as it was.
    const giga3 = bonk(runner, standing, 3);
    expect(giga3.knock.vx).toBeCloseTo(plain.knock.vx * 3);
    expect(giga3.knock.up).toBeGreaterThan(0);
    expect(giga3.ball.vx).toBeCloseTo(plain.ball.vx);
    expect(giga3.ball.vy).toBe(0);
    expect(giga3.spent).toEqual({ mine: 3, theirs: 0 });
    // Harder: along the floe it stops at the top, and the rest throws it up the higher, to the sky's top.
    const giga100 = bonk(runner, standing, 100);
    expect(giga100.knock.vx).toBeCloseTo(GIGA_TOP);
    expect(giga100.knock.up).toBeGreaterThan(giga3.knock.up);
    expect(bonk(runner, standing, GIGA_MOST).knock.up).toBe(SKY_TOP);
    // The one run into is giga: the runner's own app gives its ball the bounce, that much harder, and says it spent the
    // other's; the other's app, working it out, gives its own knock to the runner the same.
    const into = bonk(runner, standing, 0, 4);
    expect(into.ball.vx - runner.vx).toBeCloseTo((plain.ball.vx - runner.vx) * 4);
    expect(into.knock).toEqual(plain.knock);
    expect(into.spent).toEqual({ mine: 0, theirs: 4 });
    const back = bonk(standing, runner, 4).knock;
    expect(back.vx).toBeCloseTo(into.ball.vx - runner.vx);
    expect(back.up).toBeCloseTo(into.ball.vy);
    // A touch too light to feel spends no giga.
    const touch = bonk({ ...runner, vx: FELT_HIT / 2 }, standing, 50, 50);
    expect(touch.spent).toEqual({ mine: 0, theirs: 0 });
    expect(touch.knock).toEqual(bonk({ ...runner, vx: FELT_HIT / 2 }, standing).knock);
    expect(bonk(runner, ballAt(5, 0), 50).spent).toEqual({ mine: 0, theirs: 0 });
    expect(giga(-2, 0)).toEqual({ along: -2, up: 0 });
  });

  it('throws a ball up with a giga: it flies, meets nobody, cannot dash, and comes down on the floe or in the sea', () => {
    const thrown = knocked(ballAt(0, 0), { vx: 4, vz: 0, up: 12 });
    expect(thrown.vy).toBe(12);
    let b = roll(thrown, { x: -1, z: 0 }, 0.05, FLOE_START);
    expect(b.y).toBeGreaterThan(0);
    expect(b.vx).toBeLessThan(4); // slowed by the air, not steered back
    expect(b.vx).toBeGreaterThan(3.5);
    expect(canDash(b, 1e9)).toBe(false);
    // Over a ball's height, it meets nobody.
    b = roll(roll(b, { x: 0, z: 0 }, 0.05, FLOE_START), { x: 0, z: 0 }, 0.05, FLOE_START);
    expect(b.y).toBeGreaterThan(BALL_RADIUS);
    expect(bonk(b, { ...ballAt(b.x + 0.5, 0), vx: -3 }).hit).toBe(0);
    expect(bonk({ ...ballAt(0, 0), vx: 3 }, { ...ballAt(0.5, 0), y: 3 }).hit).toBe(0);
    for (let i = 0; i < 40 && b.y > 0; i++) b = roll(b, { x: 0, z: 0 }, 0.05, FLOE_START);
    expect(b).toMatchObject({ alive: true, y: 0, vy: 0 });
    expect(b.x).toBeGreaterThan(1);
    // Out over the sea, still in the air: out already, and on down into it.
    let far = knocked({ ...ballAt(FLOE_START - 1, 0), vx: 0 }, { vx: 10, vz: 0, up: 8 });
    for (let i = 0; i < 40 && far.alive; i++) far = roll(far, { x: 0, z: 0 }, 0.05, FLOE_START);
    expect(far).toMatchObject({ alive: false });
    expect(far.x).toBeGreaterThan(FLOE_START);
    expect(far.y).toBeGreaterThan(0);
    for (let i = 0; i < 80; i++) far = roll(far, { x: 0, z: 0 }, 0.05, FLOE_START);
    expect(far.y).toBe(SUNK_Y);
  });

  it('a winner drops a mystery ball for every ten wins, one a round, at its start', () => {
    expect([0, 9, 10, 19, 20, 35].map((w) => dropsLeft(w, 0))).toEqual([0, 0, 1, 1, 2, 3]);
    expect(dropsLeft(20, 2)).toBe(0);
    expect(dropsLeft(10, 3)).toBe(0);
    const r: Round = { n: 3, phase: 'count', since: 0, players: [A, B], winner: null, wins: { [A]: 10, [B]: 25 } };
    const s = stageOf(firstStage(), 3);
    const asked = ask(s, r, A, 100);
    expect(asked).toMatchObject({ asked: A, used: { [A]: 1 } });
    // One a round; none without the wins; none once the round has played a while, or of another round.
    expect(ask(asked, r, B, 100)).toBe(asked);
    expect(ask(s, { ...r, wins: { [A]: 9 } }, A, 100)).toBe(s);
    expect(ask(s, { ...r, phase: 'play' }, A, DROP_PLAY_MS - 1).asked).toBe(A);
    expect(ask(s, { ...r, phase: 'play' }, A, DROP_PLAY_MS)).toBe(s);
    expect(ask(s, { ...r, phase: 'over' }, A, 100)).toBe(s);
    expect(ask(stageOf(firstStage(), 2), r, A, 100).asked).toBeNull();
    // Not while another mystery ball is on the floe.
    expect(ask(dropped(s, 50), r, A, 100).asked).toBeNull();
    // It falls at the go; still one a round, though it is gone off the floe within the first seconds.
    const fell = dropped({ ...asked, bonks: 40, next: 60 }, 99);
    expect(fell).toMatchObject({ ball: 1, asked: A, waiting: false, bonks: 40, next: 60 }); // a drop leaves the count be
    expect(ask(gone(fell, 1000, 'fast', 2), { ...r, phase: 'play' }, B, 1000).asked).toBe(A);
    // A's one is used: the next round, none; B's two go on.
    const next = stageOf(fell, 4);
    expect(next).toMatchObject({ n: 4, asked: null, used: { [A]: 1 } });
    expect(ask(next, { ...r, n: 4 }, A, 100)).toBe(next);
    expect(ask(next, { ...r, n: 4 }, B, 100).asked).toBe(B);
    // A drop that never fell, the round gone back to waiting for a friend: given back.
    expect(stageOf(asked, 4).used).toEqual({ [A]: 0 });
  });

  it('drops a mystery ball by itself once the felt bonks, counted by both balls, come to the draw, and counts again to a new one', () => {
    const s = { ...stageOf(firstStage(30), 1), bonks: 59 };
    expect(dropDue(s)).toBe(false);
    expect(dropDue({ ...s, bonks: 60 })).toBe(true);
    expect(dropped({ ...s, bonks: 60 }, 120)).toMatchObject({ ball: 1, bonks: 0, next: 120 });
    // The count goes on from round to round.
    expect(stageOf({ ...s, bonks: 60 }, 2).bonks).toBe(60);
  });

  it('gives what is in a mystery ball to who bonked it last when it went off, for the round', () => {
    let s = dropped(stageOf(firstStage(), 2), 50);
    expect(s).toMatchObject({ ball: 1, by: null, asked: null });
    s = touched(touched(s, 1, A), 1, B);
    expect(touched(s, 7, A).by).toBe(B); // another ball's bonk, gone already
    s = gone(s, 12_345.6, 'heavy', 50);
    expect(s.got).toEqual([{ id: 1, who: B, item: 'heavy', power: 0, t: 12_346 }]);
    expect(s.ball).toBe(0);
    expect(effectsOf(s, B)).toEqual({ heavy: true, handling: false });
    expect(effectsOf(s, A)).toEqual({ heavy: false, handling: false });
    // Off with nobody's bonk on it: nobody's.
    expect(gone(dropped(s, 50), 20_000, 'fast', 2).got).toHaveLength(1);
    // A giga keeps its power; double speed, when it began.
    s = gone(touched(dropped(s, 50), 2, A), 30_000, 'giga', 37.5);
    s = gone(touched(dropped(s, 50), 3, A), 40_000, 'fast', 9);
    expect(s.got.slice(1)).toEqual([{ id: 2, who: A, item: 'giga', power: 37.5, t: 30_000 }, { id: 3, who: A, item: 'fast', power: 0, t: 40_000 }]);
    expect(fastFrom(s)).toBe(40_000);
    // The next round, all gone.
    expect(stageOf(s, 3)).toMatchObject({ got: [], ball: 0 });
    expect(fastFrom(stageOf(s, 3))).toBeNull();
  });

  it('moves a heavy ball hard and slow, a handling one quick to turn and stop, and everything twice as fast at double speed', () => {
    expect(movesOf({ heavy: false, handling: false })).toEqual(PLAIN);
    const heavy = movesOf({ heavy: true, handling: false }), handling = movesOf({ heavy: false, handling: true });
    expect(heavy.mass).toBe(HEAVY_MASS);
    expect(heavy.accel).toBeLessThan(PLAIN.accel);
    expect(heavy.top).toBeLessThan(PLAIN.top);
    expect(handling.accel).toBeGreaterThan(PLAIN.accel);
    expect(handling.drag).toBeGreaterThan(PLAIN.drag);
    // Rolled the same way for a second: the heavy one goes less far, the handling one stops sooner once let go.
    const go = (m: typeof PLAIN, steps: number, dir: { x: number; z: number }, from = ballAt(0, 0)) => { let b = from; for (let i = 0; i < steps; i++) b = roll(b, dir, 0.02, 100, m); return b; };
    expect(go(heavy, 50, { x: 1, z: 0 }).x).toBeLessThan(go(PLAIN, 50, { x: 1, z: 0 }).x);
    const fast = { ...ballAt(0, 0), vx: 7 };
    expect(go(handling, 25, { x: 0, z: 0 }, fast).vx).toBeLessThan(go(PLAIN, 25, { x: 0, z: 0 }, fast).vx);
    // A heavy ball run into by a plain one moves half as much, and the plain one bounces back hard.
    const runner: Ball = { ...ballAt(0, 0), vx: 6 };
    const standing: Ball = ballAt(2 * BALL_RADIUS - 0.2, 0);
    const plain = bonk(runner, standing), intoHeavy = bonk(runner, standing, 0, 0, 1, HEAVY_MASS);
    expect(intoHeavy.knock.vx).toBeCloseTo(plain.knock.vx / 2); // three times the mass: half the knock
    expect(intoHeavy.ball.vx).toBeLessThan(plain.ball.vx);
    // Momentum along the line is kept.
    expect(intoHeavy.ball.vx + HEAVY_MASS * intoHeavy.knock.vx).toBeCloseTo(6);
    // Double speed from 10 s in: the floe's clock runs twice as fast from then.
    expect(playClock(5000, 10_000)).toBe(5000);
    expect(playClock(15_000, 10_000)).toBe(10_000 + 5000 * FAST);
    expect(playClock(15_000, null)).toBe(15_000);
    expect([speedAt(9999, 10_000), speedAt(10_000, 10_000), speedAt(1e6, null)]).toEqual([1, FAST, 1]);
  });

  it('drops a mystery ball from the sky onto the middle of the floe', () => {
    let b: Ball = { ...ballAt(0, 0), y: DROP_Y };
    for (let i = 0; i < 100 && b.y > 0; i++) b = roll(b, { x: 0, z: 0 }, 0.02, FLOE_START);
    expect(b).toMatchObject({ x: 0, z: 0, y: 0, vy: 0, alive: true });
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
    r = advance(r, at(r, 30_000), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }));
    expect(r).toMatchObject({ phase: 'play', standing: [A, B] });
    r = advance(r, at(r, 31_000), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: false }));
    expect(r.phase).toBe('play');
    r = advance(r, at(r, 31_000 + TIE_MS), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: false }));
    expect(r).toMatchObject({ phase: 'over', winner: A, wins: { [A]: 1 } });
    expect(advance(r, at(r, OVER_MS - 1), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }))).toBe(r);
    r = advance(r, at(r, OVER_MS), here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }, { who: C, n: 0, known: 0, alive: true }));
    expect(r).toMatchObject({ n: 2, phase: 'count', players: [A, B, C], winner: null, wins: { [A]: 1 } });
  });

  it('counts a player gone from the game as fallen, one not yet in the round as standing, and a draw for nobody', () => {
    let r: Round = { ...firstRound(0), n: 3, phase: 'play', players: [A, B, C] };
    // C's app has not taken round 3 yet: still in it.
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: true }, { who: B, n: 3, known: 3, alive: false }, { who: C, n: 2, known: 2, alive: false }))).toMatchObject({ phase: 'play', standing: [A, C] });
    // C reloaded, and watches round 3: out of it, and A wins, at once to a leader that never counted two standing; with B
    // back too, the round still ends.
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: true }, { who: B, n: 3, known: 3, alive: false }, { who: C, n: 0, known: 3, alive: false }))).toMatchObject({ phase: 'over', winner: A });
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: false }, { who: B, n: 0, known: 3, alive: false }, { who: C, n: 0, known: 3, alive: false }))).toMatchObject({ phase: 'over', winner: null });
    // C left the game: A stands alone.
    expect(advance(r, 1000, here({ who: A, n: 3, known: 3, alive: true }, { who: B, n: 3, known: 3, alive: false }))).toMatchObject({ phase: 'over', winner: A });
    // All fell at once, to a leader that never counted them standing (it took over just now): nobody's.
    r = advance(r, 1000, here({ who: A, n: 3, known: 3, alive: false }, { who: B, n: 3, known: 3, alive: false }, { who: C, n: 3, known: 3, alive: false }));
    expect(r).toMatchObject({ phase: 'over', winner: null, wins: {} });
    expect(r.tied).toBeUndefined();
    // Alone after it: the wait.
    expect(advance(r, at(r, OVER_MS), here({ who: A, n: 3, known: 3, alive: true }))).toMatchObject({ phase: 'wait', players: [] });
  });

  it('waits TIE_MS on the last one standing: who falls within it shares the round with who fell last, each given a win', () => {
    const play: Led = { ...firstRound(0), n: 3, phase: 'play', players: [A, B, C], wins: { [A]: 2 } };
    const of = (a: boolean, b: boolean, c: boolean) => here({ who: A, n: 3, known: 3, alive: a }, { who: B, n: 3, known: 3, alive: b }, { who: C, n: 3, known: 3, alive: c });
    // Three on the floe, then two: counted, and nothing else changes; counted the same again, the round as it was.
    let r = advance(play, 1000, of(true, true, true));
    expect(r).toMatchObject({ phase: 'play', standing: [A, B, C] });
    r = advance(r, 2000, of(true, true, false));
    expect(r).toMatchObject({ phase: 'play', standing: [A, B] });
    expect(advance(r, 2100, of(true, true, false))).toBe(r);
    // B falls: A is on alone, but not the winner yet.
    r = advance(r, 3000, of(true, false, false));
    expect(r).toMatchObject({ phase: 'play', closing: { at: 3000, who: [A, B] } });
    expect(advance(r, 3000 + TIE_MS - 1, of(true, false, false))).toBe(r);
    // A falls too, within it: a photo finish, A and B each a win, and C, who fell long before, none.
    const tie = advance(r, 3000 + TIE_MS - 1, of(false, false, false));
    expect(tie).toEqual({ n: 3, phase: 'over', since: 3000 + TIE_MS - 1, players: [A, B, C], winner: null, tied: [A, B], wins: { [A]: 3, [B]: 1 } });
    // A stands TIE_MS: A wins alone.
    expect(advance(r, 3000 + TIE_MS, of(true, false, false))).toEqual({ n: 3, phase: 'over', since: 3000 + TIE_MS, players: [A, B, C], winner: A, wins: { [A]: 3 } });
    // The last two fall in the same count: theirs, at once; three at once, the three's.
    expect(advance(advance(play, 1000, of(true, true, false)), 1050, of(false, false, false))).toMatchObject({ phase: 'over', winner: null, tied: [A, B], wins: { [A]: 3, [B]: 1 } });
    expect(advance(advance(play, 1000, of(true, true, true)), 1050, of(false, false, false))).toMatchObject({ tied: [A, B, C], wins: { [A]: 3, [B]: 1, [C]: 1 } });
    // A leader that counts only now and then (its tab hidden) sees B down, then none, past TIE_MS: A stood it out.
    expect(advance(r, 3000 + TIE_MS + 400, of(false, false, false))).toMatchObject({ phase: 'over', winner: A, wins: { [A]: 3 } });
    // Two fall at once, one stands TIE_MS on: that one wins.
    r = advance(advance(play, 1000, of(true, true, true)), 1050, of(true, false, false));
    expect(advance(r, 1050 + TIE_MS, of(true, false, false))).toMatchObject({ phase: 'over', winner: A });
    // A tie is shown until the next round counts down, which starts with nothing of it, nor of the play's counting.
    const next = advance(tie, at(tie, OVER_MS), of(true, true, true));
    expect(next).toEqual({ n: 4, phase: 'count', since: at(tie, OVER_MS), players: [A, B, C], winner: null, wins: { [A]: 3, [B]: 1 } });
    expect(advance(tie, at(tie, OVER_MS), here({ who: A, n: 3, known: 3, alive: true }))).toEqual({ n: 3, phase: 'wait', since: at(tie, OVER_MS), players: [], winner: null, wins: { [A]: 3, [B]: 1 } });
  });

  it('counts down again, with everyone in, when who is here changes during the countdown', () => {
    // Two apps each counted round 1 down, with some of the players (CI, 2026-11-26: B and C by B's count, A and C by A's),
    // and A, who knows the same round and has the smaller key, now leads them all: B is in its round too, from the start
    // of a countdown, not left believing it plays a round A does not count it in.
    const r: Round = { ...firstRound(0), n: 1, phase: 'count', since: 0, players: [A, C] };
    const all = here({ who: A, n: 1, known: 1, alive: true }, { who: B, n: 1, known: 1, alive: true }, { who: C, n: 1, known: 1, alive: true });
    expect(advance(r, 2000, all)).toEqual({ n: 1, phase: 'count', since: 2000, players: [A, B, C], winner: null, wins: {} });
    // A friend who links during the countdown is in it, from the start of another; one who goes, out of it.
    expect(advance(r, 2000, here({ who: A, n: 1, known: 1, alive: true }, { who: C, n: 1, known: 1, alive: true }, { who: B, n: 0, known: 0, alive: true }))).toMatchObject({ phase: 'count', since: 2000, players: [A, B, C] });
    const three: Round = { ...r, players: [A, B, C] };
    expect(advance(three, 2000, here({ who: A, n: 1, known: 1, alive: true }, { who: C, n: 1, known: 1, alive: true }))).toMatchObject({ phase: 'count', since: 2000, players: [A, C] });
    // The same players: on to the play.
    expect(advance(three, COUNT_MS, all)).toMatchObject({ phase: 'play', players: [A, B, C] });
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
    const h = hitFrame(BOB, { vx: 7.0711, vz: -1, up: 0 }, 6.5);
    expect(parseFrame(JSON.stringify(h))).toEqual({ k: 'h', to: B, vx: 7.07, vz: -1, hit: 6.5 });
    // A giga ball, and a bonk that spent a giga or two.
    expect(parseFrame(JSON.stringify(ballFrame(ballAt(0, 0), 1, 1, false, 37.5)))).toMatchObject({ g: 37.5 });
    expect(parseFrame(JSON.stringify(hitFrame(BOB, { vx: 60, vz: 0, up: 21.234 }, 6.5, { mine: 37, theirs: 0 })))).toEqual({ k: 'h', to: B, vx: 60, vz: 0, hit: 6.5, up: 21.23, g: 37 });
    expect(parseFrame(JSON.stringify(hitFrame(BOB, { vx: 1, vz: 0, up: 0 }, 6.5, { mine: 2, theirs: GIGA_MOST })))).toMatchObject({ g: 2, u: GIGA_MOST });
    expect(parseFrame(JSON.stringify(ballFrame(ballAt(0, 0), 1, 1, false, 0, 42)))).toMatchObject({ c: 42 });
  });

  it('reads back the items: the stage with the round, the mystery ball, a push and a drop; apps from before items as before', () => {
    const r: Round = { n: 2, phase: 'play', since: 1000, players: [A, B], winner: null, wins: { [A]: 12 } };
    let s = ask(stageOf(firstStage(), 2), { ...r, phase: 'count' }, A, 0);
    s = gone(touched(dropped({ ...s, bonks: 17, next: 80 }, 50), 1, B), 3000, 'giga', 4.5);
    const f = stageFrame(r, s, 1500, 7);
    const back = parseFrame(JSON.stringify(f));
    expect(back).toEqual(f);
    expect(stageOfFrame(back as typeof f)).toEqual(s);
    // An app from before items reads the round all the same (core/rounds.ts), and one from after reads a round with no stage.
    expect(parseFrame(JSON.stringify(roundFrame(r, 1500, 7)))).toEqual(roundFrame(r, 1500, 7));
    expect(stageOfFrame(roundFrame(r, 1500, 7))).toBeNull();
    // A stage that is off is left out, the round kept.
    expect(parseFrame(JSON.stringify({ ...f, st: { ...f.st, g: [[1, B, 'banana', 0, 0]] } }))).toEqual(roundFrame(r, 1500, 7));
    const i = itemFrame(3, { ...ballAt(1.234, -2), vx: 5, y: 7.891 });
    expect(parseFrame(JSON.stringify(i))).toEqual({ k: 'i', id: 3, x: 1.23, z: -2, vx: 5, vz: 0, y: 7.89, vy: 0, a: true });
    const p = pushFrame(3, { vx: 4.444, vz: -1, up: 0 });
    expect(parseFrame(JSON.stringify(p))).toEqual({ k: 'p', id: 3, vx: 4.44, vz: -1, up: 0 });
    expect(parseFrame(JSON.stringify({ k: 'd', n: 4 }))).toEqual({ k: 'd', n: 4 });
    for (const off of [{ ...i, id: 0 }, { ...i, x: 'x' }, { ...p, vx: 500 }, { ...p, up: -1 }, { k: 'd', n: 0 }, { k: 'd' }]) expect(parseFrame(JSON.stringify(off))).toBeNull();
  });

  it('reads back a tie with the round, and a wind; leaves out a tie that is off, the round kept', () => {
    const r: Round = { n: 2, phase: 'over', since: 1000, players: [A, B, C], winner: null, tied: [A, B], wins: { [A]: 1, [B]: 1 } };
    const f = roundFrame(r, 1500, 7);
    expect(f.ti).toEqual([A, B]);
    expect(parseFrame(JSON.stringify(f))).toEqual(f);
    expect(roundOf(f, 90_000)).toEqual({ ...r, since: 89_500 });
    // No tie, no field: as apps from before ties send it, and read it.
    expect(roundFrame({ ...r, tied: [] }, 1500, 7)).not.toHaveProperty('ti');
    for (const ti of [[A, 'x'], 'x', Array(17).fill(A)]) expect(parseFrame(JSON.stringify({ ...f, ti }))).toEqual(roundFrame({ ...r, tied: [] }, 1500, 7));
    const w = gustFrame(3, gust({ x: 1, z: 2 }, 0)!);
    expect(w).toEqual({ k: 'w', n: 3, x: 0.45, z: 0.89 });
    const back = parseFrame(JSON.stringify(w));
    expect(back).toMatchObject({ k: 'w', n: 3 });
    expect(Math.hypot((back as typeof w).x, (back as typeof w).z)).toBeCloseTo(1, 10);
    for (const off of [{ n: 0 }, { x: 2 }, { x: 0, z: 0 }, { z: 'x' }, { n: 1.5 }]) expect(parseFrame(JSON.stringify({ ...w, ...off }))).toBeNull();
  });

  it('drops anything off', () => {
    const good = { k: 'r', q: 1, n: 1, ph: 'play', t: 0, ps: [A], w: null, wins: [[A, 1]] };
    for (const off of [{ ph: 'dance' }, { n: -1 }, { t: 1.5 }, { ps: ['x'] }, { ps: Array(17).fill(A) }, { q: 0.5 }, { w: 'x' }, { wins: [[A, -1]] }, { wins: [[A]] }]) {
      expect(parseFrame(JSON.stringify({ ...good, ...off }))).toBeNull();
    }
    const ball = { k: 'b', r: 0, n: 0, x: 0, z: 0, vx: 0, vz: 0, y: 0, a: true, d: false };
    expect(parseFrame(JSON.stringify(ball))).toEqual(ball);
    // A giga off is taken as none: the ball still moves.
    for (const g of [1, 2e6, null, '5']) expect(parseFrame(JSON.stringify({ ...ball, g }))).toEqual(ball);
    for (const off of [{ x: 1e9 }, { x: 'NaN' }, { a: 1 }, { r: 0.5 }, { n: -1 }, { k: 'x' }]) expect(parseFrame(JSON.stringify({ ...ball, ...off }))).toBeNull();
    const hit = { k: 'h', to: A, vx: 1, vz: 1, hit: 2 };
    expect(parseFrame(JSON.stringify(hit))).toEqual(hit);
    for (const off of [{ g: 0 }, { u: 2e6 }, { u: '5' }, { up: -1 }, { up: 'x' }]) expect(parseFrame(JSON.stringify({ ...hit, ...off }))).toEqual(hit);
    expect(parseFrame(JSON.stringify({ ...hit, up: 500 }))).toEqual({ ...hit, up: SKY_TOP });
    for (const off of [{ to: 'x' }, { vx: 1000 }, { hit: -1 }, { vz: null }]) expect(parseFrame(JSON.stringify({ ...hit, ...off }))).toBeNull();
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame(new ArrayBuffer(4))).toBeNull();
    expect(parseFrame('x'.repeat(5000))).toBeNull();
  });
});
