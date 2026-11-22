import { describe, expect, it } from 'vitest';
import {
  CLIMBS, COUNT_MS, FAST_MS, FELL, FIRST_BET_MS, GOLD_CHANCE, INTEREST, MAGNET, MULTS, NET, OFF, OVER_MS, PAUSE_MS, RIDING, START_CHIPS, TOP,
  advance, buy, canFlip, climbAt, climbFrame, climbOf, clinkMs, costOf, earn, flip, follow, grab, newClimb, newSeat, nextOdds, odds, parseFrame,
  payout, raiseOf, seatFrame, SHOP, UPGRADES, type Climb, type Counted, type Seat, type Table,
} from '../src/core/clink';
import { firstRound, roundFrame, whoOf } from '../src/core/rounds';

const [A, B, C] = ['A', 'B', 'C'].map((c) => whoOf(c.repeat(87))) as [string, string, string];
/** A random that gives these, then the last again and again. */
const dice = (...rolls: number[]) => { let i = 0; return () => rolls[Math.min(i++, rolls.length - 1)]!; };
/** Lands: never topples, never golden, a wobbly mood. */
const steady = () => 0.5;

/** The climb run by the leader to `ms`, coin by coin, as its app would on every frame. */
function runTo(cl: Climb, ms: number, rand: () => number, riders = 1, potPerCoin = 10): Climb {
  for (let t = 0; t <= ms; t += 50) cl = climbAt(cl, t, rand, riders, potPerCoin);
  return climbAt(cl, ms, rand, riders, potPerCoin);
}

describe('Clink, the tower (core/clink.ts)', () => {
  it('pays more the higher it is, and is likelier to fall the higher it is and the more a coin shakes', () => {
    for (let h = 1; h <= TOP; h++) expect(MULTS[h]!).toBeGreaterThan(MULTS[h - 1]!);
    for (let k = 2; k <= TOP; k++) for (const m of [0, 1, 2] as const) expect(odds(k, m)).toBeGreaterThanOrEqual(odds(k - 1, m));
    for (let k = 1; k <= TOP; k++) { expect(odds(k, 0)).toBeLessThan(odds(k, 1)); expect(odds(k, 1)).toBeLessThan(odds(k, 2)); expect(odds(k, 2)).toBeLessThanOrEqual(90); }
  });

  it('lands no coin before the stakes close, then one on time, each with the next one\'s mood known', () => {
    let cl = newClimb(1, 0, 0, 0.5, true);
    expect(cl.bet).toBe(FIRST_BET_MS);
    expect(nextOdds(cl)).toBe(odds(1, 1));
    expect(climbAt(cl, cl.bet, steady, 1, 10)).toBe(cl);
    const first = cl.next;
    expect(first).toBe(FIRST_BET_MS + clinkMs(0));
    cl = climbAt(cl, first, steady, 1, 10);
    expect(cl.h).toBe(1);
    expect(cl.moods).toHaveLength(2);
    expect(cl.next).toBe(first + clinkMs(1));
    expect(cl.fell).toBe(-1);
    expect(cl.pot).toBe(10);
  });

  it('falls when a coin topples it, at that coin', () => {
    // Coin 1 lands (0.5, then a gold roll and a mood), coin 2 topples (0.0).
    let cl = newClimb(3, 0, 0, 0.5);
    cl = climbAt(cl, cl.next, dice(0.5, 0.5, 0.5, 0), 1, 0);
    expect(cl.h).toBe(1);
    const at = cl.next;
    cl = climbAt(cl, at, dice(0), 1, 0);
    expect(cl).toMatchObject({ h: 1, fell: at });
    expect(nextOdds(cl)).toBeNull();
    // Over is over.
    expect(climbAt(cl, at + 99_999, steady, 1, 0)).toBe(cl);
  });

  it('pays the pot on a golden coin while anyone is on, and starts it again', () => {
    let cl = newClimb(1, 0, 500, 0.5);
    // Lands (0.5), golden (0.0), mood (0.5).
    cl = climbAt(cl, cl.next, dice(0.5, 0, 0.5), 2, 40);
    expect(cl.gold).toEqual([[1, 540]]);
    expect(cl.pot).toBe(0);
    expect(GOLD_CHANCE).toBeGreaterThan(0);
  });

  it('with nobody on: no golden coin, nothing in the pot, and the coins quickly down to where it falls', () => {
    let cl = newClimb(1, 0, 500, 0.5);
    cl = climbAt(cl, cl.next, dice(0.5, 0, 0.5), 0, 40);
    expect(cl.gold).toEqual([]);
    expect(cl.pot).toBe(500);
    const at = cl.next;
    cl = climbAt(cl, at, steady, 0, 40);
    expect(cl.next - at).toBe(FAST_MS);
  });

  it('ends at the top, every coin landed', () => {
    const cl = runTo(newClimb(1, 0, 0, 0.5), 60_000, steady);
    expect(cl.h).toBe(TOP);
    expect(cl.fell).toBeGreaterThan(0);
  });
});

describe('Clink, a seat at the table (core/clink.ts)', () => {
  const open = (c = 1): Climb => newClimb(c, 0, 0, 0.5);

  it('puts my share on the tower when the stakes close, and keeps the rest', () => {
    const cl = open();
    let s: Seat = { ...newSeat(), share: 4 };
    s = follow(s, cl, 0);
    expect(s).toMatchObject({ c: 1, placed: false, at: OFF, chips: START_CHIPS });
    s = follow(s, cl, cl.bet);
    expect(s).toMatchObject({ placed: true, stake: START_CHIPS / 4, chips: START_CHIPS * 3 / 4, at: RIDING, kept: START_CHIPS * 3 / 4 });
    // Once only.
    expect(follow(s, cl, cl.bet + 10)).toEqual(s);
  });

  it('sits a climb out that it came to after a coin landed: nothing at stake', () => {
    const cl = climbAt(open(), open().next, steady, 1, 0);
    const s = follow(newSeat(), cl, cl.next - 1);
    expect(s).toMatchObject({ placed: true, stake: 0, at: OFF, chips: START_CHIPS });
  });

  it('pays a grab what the coins it saw made, more with a lucky charm and in a later climb', () => {
    let cl = open();
    let s = follow(newSeat(), cl, cl.bet);
    cl = runTo(cl, cl.next + clinkMs(1) + clinkMs(2), steady);
    expect(cl.h).toBe(3);
    const g = grab(s, cl.h);
    expect(g.at).toBe(3);
    expect(g.won).toBe(Math.floor(START_CHIPS / 2 * MULTS[3]!));
    expect(g.chips).toBe(START_CHIPS / 2 + g.won);
    // Off is off: a second grab does nothing, and the fall does nothing to it.
    expect(grab(g, 5)).toBe(g);
    expect(follow(g, { ...cl, fell: cl.next }, cl.next).chips).toBe(g.chips);
    // A charm: the win made bigger, the stake as it was.
    const charmed = buy({ ...newSeat(), chips: 10_000 }, 'charm');
    expect(payout(100, 3, charmed.levels, 1) - 100).toBeCloseTo((MULTS[3]! - 1) * 100 * 1.3);
    // A later climb pays more.
    expect(raiseOf(CLIMBS)).toBeGreaterThan(raiseOf(1));
    expect(payout(100, 3, s.levels, CLIMBS)).toBeGreaterThan(payout(100, 3, s.levels, 1));
    s = { ...s, c: CLIMBS };
    expect(grab(s, 3).won).toBe(Math.floor(payout(s.stake, 3, s.levels, CLIMBS)));
  });

  it('loses a stake that falls with the tower, but what a safety net keeps', () => {
    const cl = open();
    const on = follow(newSeat(), cl, cl.bet);
    const fallen = { ...cl, fell: cl.next };
    expect(follow(on, fallen, cl.next)).toMatchObject({ at: FELL, chips: START_CHIPS / 2 });
    const netted = follow(buy({ ...newSeat(), chips: 2000 }, 'net'), cl, cl.bet);
    expect(follow(netted, fallen, cl.next).chips).toBe(netted.chips + netted.stake * NET[1]!);
  });

  it('pays a stake still on at the top what the top pays', () => {
    const cl = runTo(open(), 60_000, steady);
    const s = follow(follow(newSeat(), open(), open().bet), cl, 60_000);
    expect(s.at).toBe(TOP);
    expect(s.won).toBe(START_CHIPS / 2 * MULTS[TOP]!);
  });

  it('pays the golden coins to who was on when they landed, the magnet more, and not to who got off before', () => {
    let cl = open();
    const on = follow(newSeat(), cl, cl.bet);
    // Coin 1 lands golden, paying 300.
    cl = { ...climbAt(cl, cl.next, dice(0.5, 0, 0.5), 1, 0), gold: [[1, 300]] };
    const stayed = follow(on, cl, cl.next);
    expect(stayed.chips).toBe(on.chips + 300);
    expect(stayed.gilded).toBe(300);
    // Got off after coin 1 landed, before this app counted it: still on when it landed.
    expect(follow(grab(on, 1), cl, cl.next).gilded).toBe(300);
    // Got off before it landed.
    expect(follow(grab(on, 0), cl, cl.next).gilded).toBe(0);
    // Not on at all.
    expect(follow(follow(newSeat(), climbAt(open(), open().next, steady, 1, 0), 1), cl, cl.next).gilded).toBe(0);
    // A magnet.
    const magnet = follow(buy({ ...newSeat(), chips: 2000 }, 'magnet'), open(), open().bet);
    expect(follow(magnet, cl, cl.next).gilded).toBe(300 * MAGNET[1]!);
    // Counted once.
    expect(follow(stayed, cl, cl.next + 50)).toEqual(stayed);
  });

  it('grows what I kept with the piggy bank once the climb is over, once', () => {
    const cl = open();
    const pig = follow(buy({ ...newSeat(), chips: 2000 }, 'piggy'), cl, cl.bet);
    expect(pig.kept).toBe(750);
    const over = follow(grab(pig, 0), { ...cl, fell: cl.next }, cl.next);
    expect(over.interest).toBe(Math.floor(750 * INTEREST[1]!));
    expect(over.chips).toBe(750 + 750 + over.interest);
    expect(follow(over, { ...cl, fell: cl.next }, cl.next + 99)).toEqual(over);
    // No piggy bank, nothing.
    expect(follow(follow(newSeat(), cl, cl.bet), { ...cl, fell: cl.next }, cl.next).interest).toBe(0);
  });

  it('starts a new climb clean', () => {
    const cl = open(1);
    const s = follow(grab(follow(newSeat(), cl, cl.bet), 0), { ...cl, fell: cl.next }, cl.next);
    const next = follow(s, open(2), 0);
    expect(next).toMatchObject({ c: 2, placed: false, stake: 0, at: OFF, won: 0, flip: 0, golds: 0, gilded: 0, interest: -1, chips: s.chips });
  });

  it('doubles or loses what a grab won, never the stake, once a climb', () => {
    let cl = open();
    const on = follow(newSeat(), cl, cl.bet);
    cl = runTo(cl, cl.next + clinkMs(1), steady);
    const g = grab(on, cl.h);
    const profit = g.won - g.stake;
    expect(profit).toBeGreaterThan(0);
    expect(canFlip(g)).toBe(true);
    const won = flip(g, 0.1);
    expect(won).toMatchObject({ flip: 1, chips: g.chips + profit });
    expect(canFlip(won)).toBe(false);
    expect(flip(won, 0.1)).toBe(won);
    expect(flip(g, 0.9)).toMatchObject({ flip: -1, chips: g.chips - profit });
    // Nothing won, nothing to flip; riding, nothing either.
    expect(canFlip(grab(on, 0))).toBe(false);
    expect(flip(on, 0.1)).toBe(on);
  });

  it('sells each thing level by level, dearer each time, only for what I have', () => {
    for (const u of UPGRADES) {
      let s: Seat = { ...newSeat(), chips: 10_000_000 };
      const costs = SHOP[u].costs;
      for (let i = 1; i < costs.length; i++) expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
      for (const cost of costs) { expect(costOf(s.levels, u)).toBe(cost); const before = s.chips; s = buy(s, u); expect(s.chips).toBe(before - cost); }
      expect(costOf(s.levels, u)).toBeNull();
      expect(buy(s, u)).toBe(s);
      const poor = { ...newSeat(), chips: costs[0]! - 1 };
      expect(buy(poor, u)).toBe(poor);
    }
  });

  it('gives everyone an allowance as time goes', () => {
    expect(earn(newSeat(0), 2000).chips).toBe(20);
  });
});

describe('Clink, the match (core/clink.ts)', () => {
  const here = (...who: [string, number, number?, boolean?][]): Counted[] => who.map(([w, n, chips = START_CHIPS, riding = false]) => ({ who: w, n, known: n, chips, riding }));

  it('climbs for practice while one waits, then counts down once a second comes', () => {
    let t: Table = { round: firstRound(0), climb: null };
    t = advance(t, 0, here([A, 0]), steady);
    expect(t.round.phase).toBe('wait');
    expect(t.climb).toMatchObject({ c: 1, h: 0 });
    for (let now = 100; now <= 30_000; now += 100) t = advance(t, now, here([A, 0]), steady);
    expect(t.round.phase).toBe('wait');
    expect(t.climb!.c).toBeGreaterThan(1);
    t = advance(t, 30_100, here([A, 0], [B, 0]), steady);
    expect(t.round).toMatchObject({ phase: 'count', n: 1, players: [A, B].sort() });
    expect(t.climb).toBeNull();
    // Back to waiting if the second goes.
    expect(advance(t, 30_200, here([A, 0]), steady).round.phase).toBe('wait');
  });

  it('plays CLIMBS climbs, each opening a while after the last ended, and then the most chips wins', () => {
    let t: Table = { round: { ...firstRound(0), n: 1, phase: 'count', players: [A, B] }, climb: null };
    let now = COUNT_MS;
    t = advance(t, now, here([A, 1], [B, 1]), steady);
    expect(t.round.phase).toBe('play');
    expect(t.climb).toMatchObject({ c: 1, bet: FIRST_BET_MS });
    // Each climb: up to the top (nobody topples it), then the pause, then the next.
    const climbs: number[] = [];
    while (t.round.phase === 'play' && now < 1_000_000) {
      now += 100;
      t = advance(t, now, here([A, 1, 5000, true], [B, 1, 7000, true]), steady);
      if (t.climb && climbs[climbs.length - 1] !== t.climb.c) climbs.push(t.climb.c);
      if (t.climb?.fell !== undefined && t.climb.fell >= 0) {
        expect(now - t.climb.t0).toBeLessThan(t.climb.fell + PAUSE_MS + 200);
      }
    }
    expect(climbs).toEqual(Array.from({ length: CLIMBS }, (_, i) => i + 1));
    expect(t.round).toMatchObject({ phase: 'over', winner: B, scores: { [A]: 5000, [B]: 7000 }, wins: { [B]: 1 } });
    expect(t.climb).toBeNull();
    // Then the next match, or the wait.
    expect(advance(t, now + OVER_MS, here([A, 1], [B, 1]), steady).round).toMatchObject({ phase: 'count', n: 2 });
    expect(advance(t, now + OVER_MS, here([A, 1]), steady).round.phase).toBe('wait');
  });

  it('carries the pot from climb to climb, made of what the table has, and starts it again with a match', () => {
    let t: Table = { round: { ...firstRound(0), n: 1, phase: 'play', since: 0, players: [A, B] }, climb: newClimb(1, 0, 0, 0.5, true) };
    t = advance(t, t.climb!.next, here([A, 1, 1000, true], [B, 1, 3000, true]), steady);
    expect(t.climb!.pot).toBeCloseTo(0.02 * 2000);
  });

  it('gives the match to the one left in it, and leaves those watching out of it', () => {
    let t: Table = { round: { ...firstRound(0), n: 3, phase: 'play', since: 0, players: [A, B] }, climb: newClimb(1, 0, 0, 0.5, true) };
    // C came in later and watches (plays no match, knows this one): out of it. B is gone.
    t = advance(t, 100, here([A, 3, 4000], [C, 0]).map((p) => (p.who === C ? { ...p, known: 3 } : p)), steady);
    expect(t.round).toMatchObject({ phase: 'over', winner: A, scores: { [A]: 4000 } });
  });

  it('keeps a match of one, started alone, going', () => {
    const t: Table = { round: { ...firstRound(0), n: 1, phase: 'play', since: 0, players: [A] }, climb: newClimb(1, 0, 0, 0.5, true) };
    expect(advance(t, 100, here([A, 1]), steady).round.phase).toBe('play');
  });
});

describe('Clink, on the wire (core/clink.ts)', () => {
  it('sends a seat and a climb as they are, and takes them back', () => {
    const s = { ...follow(newSeat(), newClimb(4, 0, 0, 0.5), 5000), chips: 1234.7 };
    const sf = seatFrame(s, 2, 2);
    expect(parseFrame(JSON.stringify(sf))).toEqual({ ...sf, ch: 1234 });
    let cl = runTo(newClimb(4, 1000, 77, 0.5), 9000, steady);
    cl = { ...cl, gold: [[2, 400]] };
    const cf = climbFrame(cl, 2, 1000 + 9000, 55);
    expect(parseFrame(JSON.stringify(cf))).toEqual(cf);
    const back = climbOf(cf, 50_000);
    expect(back).toEqual({ ...cl, t0: 50_000 - 9000, pot: Math.floor(cl.pot) });
    const rf = roundFrame(firstRound(0), 10, 3);
    expect(parseFrame(JSON.stringify(rf))).toEqual(rf);
  });

  it('turns away a frame with anything off', () => {
    const sf = seatFrame(newSeat(), 1, 1);
    const cf = climbFrame(newClimb(1, 0, 0, 0.5), 1, 0, 1);
    for (const bad of [
      { ...sf, ch: -1 }, { ...sf, ch: 1.5 }, { ...sf, sh: 3 }, { ...sf, a: 21 }, { ...sf, a: -4 }, { ...sf, f: 2 }, { ...sf, lv: 'x' }, { ...sf, lv: [99] },
      { ...cf, h: 21 }, { ...cf, m: [3] }, { ...cf, m: [] }, { ...cf, fl: -2 }, { ...cf, gd: [[0, 5]] }, { ...cf, gd: [[1, -5]] }, { ...cf, q: 'x' }, { ...cf, t: -1 },
      { k: 'z' },
    ]) expect(parseFrame(JSON.stringify(bad))).toBeNull();
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame(JSON.stringify([1]))).toBeNull();
  });
});
