import { describe, expect, it } from 'vitest';
import {
  CLIMBS, COUNT_MS, FELL, FIRST_BET_MS, INTEREST, MAGNET, MULTS, NET, OFF, OVER_MS, PAUSE_MS, RIDING, START_CHIPS, TOP,
  advance, buy, canFlip, climbAt, climbsTo, clinkMs, costOf, earn, flip, follow, grab, matchFrame, newSeat, nextOdds, odds, parseFrame,
  payout, potCoin, raiseOf, rankOf, rollsOf, scriptOf, seatFrame, SHOP, UPGRADES, type Climb, type Counted, type Lead, type Roll, type Script, type Seat,
} from '../src/core/clink';
import { firstRound, roundFrame, whoOf } from '../src/core/rounds';

const [A, B, C] = ['A', 'B', 'C'].map((c) => whoOf(c.repeat(87))) as [string, string, string];
/** Dice that land every coin, none golden, each wobbly (0.5); but these: [climb, coin, what, roll]. */
const dice = (...but: [number, number, number, number][]): Roll => (c, k, what) => but.find(([bc, bk, bw]) => bc === c && bk === k && bw === what)?.[3] ?? 0.5;
const steady = dice();
const script = (rolls: Roll = steady, c = 1, potIn = 0): Script => scriptOf(rolls, c, 0, potIn, c === 1);
const open = (c = 1): Climb => climbAt(script(steady, c), 0);
const TOPPLES = 2, GOLDEN = 3;

describe('Clink, the tower (core/clink.ts)', () => {
  it('pays more the higher it is, and is likelier to fall the higher it is and the more a coin shakes', () => {
    for (let h = 1; h <= TOP; h++) expect(MULTS[h]!).toBeGreaterThan(MULTS[h - 1]!);
    for (let k = 2; k <= TOP; k++) for (const m of [0, 1, 2] as const) expect(odds(k, m)).toBeGreaterThanOrEqual(odds(k - 1, m));
    for (let k = 1; k <= TOP; k++) { expect(odds(k, 0)).toBeLessThan(odds(k, 1)); expect(odds(k, 1)).toBeLessThan(odds(k, 2)); expect(odds(k, 2)).toBeLessThanOrEqual(90); }
  });

  it('lands no coin before the stakes close, then each on time, the next one\'s mood known', () => {
    const sc = script();
    expect(sc.bet).toBe(FIRST_BET_MS);
    expect(sc.at[0]).toBe(FIRST_BET_MS + clinkMs(0));
    expect(sc.at[1]).toBe(sc.at[0]! + clinkMs(1));
    for (const ms of [0, sc.bet, sc.at[0]! - 1]) expect(climbAt(sc, ms)).toMatchObject({ h: 0, next: sc.at[0], fell: -1, pot: 0 });
    expect(nextOdds(climbAt(sc, 0))).toBe(odds(1, 1));
    const one = climbAt(sc, sc.at[0]!);
    expect(one).toMatchObject({ h: 1, next: sc.at[1], fell: -1, pot: potCoin(1) });
    expect(one.moods).toHaveLength(2);
  });

  it('falls when a coin topples it, at that coin, no sooner', () => {
    const sc = script(dice([1, 2, TOPPLES, 0]));
    expect(sc.falls).toBe(2);
    expect(sc.end).toBe(sc.at[1]);
    expect(climbAt(sc, sc.at[0]!)).toMatchObject({ h: 1, fell: -1 });
    const fallen = climbAt(sc, sc.at[1]!);
    expect(fallen).toMatchObject({ h: 1, fell: sc.at[1] });
    expect(nextOdds(fallen)).toBeNull();
  });

  it('pays the pot on a golden coin, and starts it again', () => {
    const sc = script(dice([1, 1, GOLDEN, 0]), 1, 500);
    expect(sc.gold).toEqual([[1, 500 + potCoin(1)]]);
    expect(climbAt(sc, sc.at[0]! - 1)).toMatchObject({ gold: [], pot: 500 });
    expect(climbAt(sc, sc.at[0]!)).toMatchObject({ gold: [[1, 500 + potCoin(1)]], pot: 0 });
    expect(climbAt(sc, sc.at[1]!).pot).toBe(potCoin(1));
    expect(potCoin(CLIMBS)).toBeGreaterThan(potCoin(1));
  });

  it('ends at the top, every coin landed', () => {
    const sc = script();
    expect(sc.falls).toBe(TOP + 1);
    expect(climbAt(sc, sc.end - 1).fell).toBe(-1);
    expect(climbAt(sc, sc.end)).toMatchObject({ h: TOP, fell: sc.end });
  });

  it('is the same from the same seed, on every screen, and another from another', () => {
    const a = rollsOf(12345), b = rollsOf(12345), c = rollsOf(54321);
    const towers = (r: Roll) => Array.from({ length: CLIMBS }, (_, i) => scriptOf(r, i + 1, 0, 0, i === 0)).map((s) => [s.falls, s.gold.length, s.moods.join('')]);
    expect(towers(a)).toEqual(towers(b));
    expect(towers(a)).not.toEqual(towers(c));
    // Its rolls spread from 0 to 1.
    const r = Array.from({ length: 4000 }, (_, i) => a(1 + (i % 10), 1 + Math.floor(i / 10), 2));
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r)).toBeLessThan(1);
    expect(r.filter((x) => x < 0.5).length / r.length).toBeCloseTo(0.5, 1);
  });

  it('opens each climb a pause after the last is over, the pot carried on, and ends the match after the last', () => {
    const known: Script[] = [];
    const rolls = rollsOf(7);
    const first = climbsTo(known, rolls, 1000, 1000, CLIMBS)!;
    expect(first).toMatchObject({ c: 1, t0: 1000, bet: FIRST_BET_MS });
    const second = climbsTo(known, rolls, 1000, first.t0 + first.end + PAUSE_MS, CLIMBS)!;
    expect(second).toMatchObject({ c: 2, t0: first.t0 + first.end + PAUSE_MS, potIn: first.potOut });
    expect(climbsTo(known, rolls, 1000, second.t0 - 1, CLIMBS)).toBe(first);
    let last = second;
    for (let c = 3; c <= CLIMBS; c++) last = climbsTo(known, rolls, 1000, last.t0 + last.end + PAUSE_MS, CLIMBS)!;
    expect(last.c).toBe(CLIMBS);
    expect(climbsTo(known, rolls, 1000, last.t0 + last.end + PAUSE_MS - 1, CLIMBS)).toBe(last);
    expect(climbsTo(known, rolls, 1000, last.t0 + last.end + PAUSE_MS, CLIMBS)).toBeNull();
    // Practice goes on.
    expect(climbsTo([], rolls, 1000, last.t0 + last.end + PAUSE_MS)!.c).toBe(CLIMBS + 1);
  });
});

describe('Clink, a seat at the table (core/clink.ts)', () => {

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
    const sc = script();
    const cl = climbAt(sc, sc.at[0]!);
    const s = follow(newSeat(), cl, sc.at[0]!);
    expect(s).toMatchObject({ placed: true, stake: 0, at: OFF, chips: START_CHIPS });
  });

  it('pays a grab what the coins it saw made, more with a lucky charm and in a later climb', () => {
    const sc = script();
    let s = follow(newSeat(), open(), sc.bet);
    const cl = climbAt(sc, sc.at[2]!);
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
    const cl = climbAt(script(), 60_000);
    const s = follow(follow(newSeat(), open(), open().bet), cl, 60_000);
    expect(s.at).toBe(TOP);
    expect(s.won).toBe(START_CHIPS / 2 * MULTS[TOP]!);
  });

  it('pays the golden coins to who was on when they landed, the magnet more, and not to who got off before', () => {
    const sc = script();
    const on = follow(newSeat(), open(), sc.bet);
    // Coin 1 lands golden, paying 300.
    const cl: Climb = { ...climbAt(sc, sc.at[0]!), gold: [[1, 300]] };
    const stayed = follow(on, cl, cl.next);
    expect(stayed.chips).toBe(on.chips + 300);
    expect(stayed.gilded).toBe(300);
    // Got off after coin 1 landed, before this app counted it: still on when it landed.
    expect(follow(grab(on, 1), cl, cl.next).gilded).toBe(300);
    // Got off before it landed.
    expect(follow(grab(on, 0), cl, cl.next).gilded).toBe(0);
    // Not on at all.
    expect(follow(follow(newSeat(), climbAt(sc, sc.at[0]!), sc.at[0]!), cl, cl.next).gilded).toBe(0);
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
    const sc = script();
    const on = follow(newSeat(), open(), sc.bet);
    const cl = climbAt(sc, sc.at[1]!);
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
  const here = (...who: [string, number, number?][]): Counted[] => who.map(([w, n, chips = START_CHIPS]) => ({ who: w, n, known: n, chips }));
  const rand = () => 0.25;

  it('waits while one is there, then counts down once a second comes, then plays with a seed of its own', () => {
    let t: Lead = { round: firstRound(0), seed: 1 };
    expect(advance(t, 100, here([A, 0]), here([A, 0]), rand, false)).toBe(t);
    t = advance(t, 200, here([A, 0], [B, 0]), here([A, 0], [B, 0]), rand, false);
    expect(t.round).toMatchObject({ phase: 'count', n: 1, players: [A, B].sort() });
    // Back to waiting if the second goes, practice on another seed.
    const back = advance(t, 300, here([A, 0]), here([A, 0]), rand, false);
    expect(back.round.phase).toBe('wait');
    expect(back.seed).not.toBe(t.seed);
    t = advance(t, 200 + COUNT_MS, here([A, 1], [B, 1]), here([A, 1], [B, 1]), rand, false);
    expect(t.round).toMatchObject({ phase: 'play', since: 200 + COUNT_MS });
    expect(t.seed).not.toBe(1);
  });

  it('plays until its climbs are over, and then the most chips wins', () => {
    const t: Lead = { round: { ...firstRound(0), n: 1, phase: 'play', players: [A, B] }, seed: 9 };
    const both = here([A, 1, 5000], [B, 1, 7000]);
    expect(advance(t, 60_000, both, both, rand, false)).toBe(t);
    const over = advance(t, 200_000, both, both, rand, true);
    expect(over.round).toMatchObject({ phase: 'over', winner: B, scores: { [A]: 5000, [B]: 7000 }, wins: { [B]: 1 } });
    expect(advance(over, 200_000 + OVER_MS, both, both, rand, false).round).toMatchObject({ phase: 'count', n: 2 });
    expect(advance(over, 200_000 + OVER_MS, here([A, 1]), here([A, 1]), rand, false).round.phase).toBe('wait');
  });

  it('keeps a friend away a while in the match; gives it to the one left once they are gone, and leaves watchers out', () => {
    const t: Lead = { round: { ...firstRound(0), n: 3, phase: 'play', players: [A, B] }, seed: 9 };
    // B not heard lately, but there (their link open): the match goes on.
    expect(advance(t, 100, here([A, 3]), here([A, 3], [B, 3]), rand, false)).toBe(t);
    // B gone; C came in later and watches (plays no match, knows this one): out of it.
    const watcher: Counted = { who: C, n: 0, known: 3, chips: START_CHIPS };
    expect(advance(t, 100, [...here([A, 3, 4000]), watcher], [...here([A, 3, 4000]), watcher], rand, false).round).toMatchObject({ phase: 'over', winner: A, scores: { [A]: 4000 } });
  });

  it('keeps a match of one, started alone, going', () => {
    const t: Lead = { round: { ...firstRound(0), n: 1, phase: 'play', players: [A] }, seed: 9 };
    expect(advance(t, 100, here([A, 1]), here([A, 1]), rand, false)).toBe(t);
  });

  it('ranks the newest round first, then how far into it', () => {
    expect(rankOf(2, 'count')).toBeGreaterThan(rankOf(1, 'wait'));
    expect(rankOf(1, 'play')).toBeGreaterThan(rankOf(1, 'count'));
    expect(rankOf(1, 'over')).toBeGreaterThan(rankOf(1, 'play'));
    expect(rankOf(1, 'wait')).toBeGreaterThan(rankOf(1, 'over'));
  });
});

describe('Clink, on the wire (core/clink.ts)', () => {
  it('sends a seat and a round with its seed as they are, and takes them back', () => {
    const s = { ...follow(newSeat(), open(4), 5000), chips: 1234.7 };
    const sf = seatFrame(s, 2, 2, 1);
    expect(parseFrame(JSON.stringify(sf))).toEqual({ ...sf, ch: 1234 });
    const mf = matchFrame(roundFrame(firstRound(0), 10, 3), 4_000_000_000);
    expect(parseFrame(JSON.stringify(mf))).toEqual(mf);
  });

  it('turns away a frame with anything off', () => {
    const sf = seatFrame(newSeat(), 1, 1, 0);
    const mf = matchFrame(roundFrame(firstRound(0), 10, 3), 5);
    for (const bad of [
      { ...sf, ch: -1 }, { ...sf, ch: 1.5 }, { ...sf, sh: 3 }, { ...sf, a: 21 }, { ...sf, a: -4 }, { ...sf, f: 2 }, { ...sf, lv: 'x' }, { ...sf, lv: [99] }, { ...sf, po: 4 },
      { ...mf, s: -1 }, { ...mf, s: 2 ** 32 }, { ...mf, s: 'x' }, { ...mf, ph: 'nap' }, { k: 'z' },
    ]) expect(parseFrame(JSON.stringify(bad))).toBeNull();
    const { s: _, ...noSeed } = mf;
    expect(parseFrame(JSON.stringify(noSeed))).toBeNull();
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame(JSON.stringify([1]))).toBeNull();
  });
});
