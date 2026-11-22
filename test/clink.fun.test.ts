import { describe, expect, it } from 'vitest';
import {
  CLIMBS, CHARM, GOLD_CHANCE, INTEREST, MAGNET, NET, PAUSE_MS, POT_RATE, RIDING, START_CHIPS, TOP, UPGRADES,
  buy, climbAt, raiseOf, costOf, earn, flip, follow, grab, newClimb, newSeat, nextOdds, payout,
  type Climb, type Seat, type Share, type Upgrade,
} from '../src/core/clink';
import { measure, report, seeded, winRates, within, type Check, type Match } from './fun';

// Clink played by bots, many matches, with the game's own rules (core/clink.ts): what the matches show, against the
// bands a fun game falls in (test/fun.ts). The bots are kinds of player: one who clicks at random, a careful one, one
// who stakes everything, one who works out each coin, one who also plays the table (risks more behind, less ahead).
// `pnpm vitest run test/clink.fun.test.ts` prints the whole report.

/** What a bot sees when it decides: the table, its own seat, the climb. */
type Ctx = { i: number; seats: Seat[]; climb: Climb; left: number; potPerCoin: number; rand: () => number };
type Bot = {
  name: string;
  share: (x: Ctx) => Share;
  /** On the tower, the next coin's odds known: stay on for it? */
  ride: (x: Ctx, odds: number) => boolean;
  flip: (x: Ctx) => boolean;
  /** One thing to buy, or null for nothing (more). */
  shop: (x: Ctx) => Upgrade | null;
};

const me = (x: Ctx): Seat => x.seats[x.i]!;
const lv = (s: Seat, u: Upgrade): number => s.levels[UPGRADES.indexOf(u)]!;
const best = (x: Ctx): number => Math.max(...x.seats.map((s, j) => (j === x.i ? -1 : s.chips + s.stake)));
const worth = (s: Seat): number => s.chips + (s.at === RIDING ? s.stake : 0);
const leading = (x: Ctx): number => worth(me(x)) / Math.max(1, best(x));

/** Staying on for the next coin against grabbing now, in chips: positive means stay. */
function edge(x: Ctx, odds: number): number {
  const s = me(x), q = odds / 100, h = x.climb.h;
  const now = payout(s.stake, h, s.levels, x.climb.c);
  const gold = GOLD_CHANCE * (x.climb.pot + x.potPerCoin) * MAGNET[lv(s, 'magnet')]!;
  const stay = (1 - q) * (payout(s.stake, h + 1, s.levels, x.climb.c) + gold) + q * s.stake * NET[lv(s, 'net')]!;
  return stay - now;
}

/** What one more level of `u` should earn me over the climbs left, roughly, as a thoughtful player reckons it. */
function worthOf(x: Ctx, u: Upgrade): number {
  const s = me(x), l = lv(s, u), left = x.left, stake = s.chips / s.share;
  const more = (t: readonly number[]) => (t[l + 1] ?? t[l]!) - t[l]!;
  switch (u) {
    case 'piggy': return more(INTEREST) * (s.chips - stake) * left;
    case 'charm': return more(CHARM) * stake * 0.8 * raiseOf(x.climb.c + left / 2) * left;
    case 'net': return more(NET) * stake * 0.35 * left;
    case 'magnet': return more(MAGNET) * GOLD_CHANCE * 5 * (x.climb.pot + 0.2 * s.chips) * left;
  }
}

/** Buys what pays for itself best in the climbs left, keeping a share of the chips to play with. */
function sensible(x: Ctx, keep = 0.6, skip: Upgrade[] = []): Upgrade | null {
  const s = me(x);
  let best: { u: Upgrade; ratio: number } | null = null;
  for (const u of UPGRADES) {
    const cost = costOf(s.levels, u);
    if (skip.includes(u) || cost === null || cost > s.chips * (1 - keep)) continue;
    const ratio = worthOf(x, u) / cost;
    if (ratio > 1.3 && (!best || ratio > best.ratio)) best = { u, ratio };
  }
  return best?.u ?? null;
}

const BOTS: Record<string, Bot> = {
  random: {
    name: 'random',
    share: (x) => ([1, 2, 4] as const)[Math.floor(x.rand() * 3)]!,
    ride: (x) => x.rand() > 0.17,
    flip: (x) => x.rand() < 0.35,
    shop: (x) => {
      if (x.rand() > 0.3) return null;
      const u = UPGRADES[Math.floor(x.rand() * UPGRADES.length)]!;
      const c = costOf(me(x).levels, u);
      return c !== null && c <= me(x).chips ? u : null;
    },
  },
  // Like a friend new to it: half in, mostly; off at a number of coins they fancy this time, or when it looks shaky; a
  // double or nothing now and then; something from the shop when it catches their eye.
  novice: {
    name: 'novice',
    share: (x) => (x.rand() < 0.15 ? 1 : x.rand() < 0.2 ? 4 : 2),
    ride: (x, o) => o < 22 && x.rand() > 0.12 && x.climb.h < 2 + Math.floor(x.rand() * 7),
    flip: (x) => x.rand() < 0.4,
    shop: (x) => (x.rand() < 0.5 ? sensible(x, 0.5) : null),
  },
  timid: { name: 'timid', share: () => 4, ride: (x, o) => x.climb.h < 3 && o < 12, flip: () => false, shop: (x) => sensible(x, 0.7) },
  allin: { name: 'allin', share: () => 1, ride: (x, o) => edge(x, o) > 0, flip: () => false, shop: (x) => sensible(x, 0.6) },
  reckless: { name: 'reckless', share: () => 1, ride: (x) => x.climb.h < 7, flip: () => true, shop: (x) => (x.left >= 5 && costOf(me(x).levels, 'charm') !== null && costOf(me(x).levels, 'charm')! <= me(x).chips * 0.3 ? 'charm' : null) },
  steady: { name: 'steady', share: () => 2, ride: (x, o) => edge(x, o) > 0, flip: () => false, shop: (x) => sensible(x) },
  hoarder: { name: 'hoarder', share: () => 2, ride: (x, o) => edge(x, o) > 0, flip: () => false, shop: () => null },
  shopper: { name: 'shopper', share: () => 2, ride: (x, o) => edge(x, o) > 0, flip: () => false, shop: (x) => { const s = me(x); return UPGRADES.find((u) => { const c = costOf(s.levels, u); return c !== null && c <= s.chips; }) ?? null; } },
  smart: {
    name: 'smart',
    share: (x) => (x.left <= 3 ? (leading(x) < 0.8 ? 1 : leading(x) > 1.4 ? 4 : 2) : 2),
    ride: (x, o) => {
      const s = me(x), lead = leading(x);
      if (x.left <= 3 && lead < 1) {
        // Behind late: on until a grab would put me ahead, while the odds are bearable.
        const would = s.chips + payout(s.stake, x.climb.h, s.levels, x.climb.c);
        if (would < best(x) * 1.05) return o < 40;
      }
      const e = edge(x, o) / Math.max(1, s.stake);
      return x.left <= 3 && lead > 1.3 ? e > 0.08 : e > 0;
    },
    flip: (x) => x.left <= 4 && leading(x) < 0.9,
    shop: (x) => sensible(x),
  },
};

type Stats = { golds: number; tops: number; nearMisses: number; flips: number; buys: number; climbs: number; busted: number };

/** One match of Clink by these bots, as the leader and their apps would play it, every rule the game's own. */
function play(bots: Bot[], rand: () => number, stats: Stats): Match {
  let seats = bots.map(() => newSeat());
  const scores: number[][] = [], times: number[] = [];
  const moments: number[][] = bots.map(() => []);
  let clock = 0, pot = 0;
  for (let c = 1; c <= CLIMBS; c++) {
    let cl = newClimb(c, 0, pot, rand(), c === 1);
    const ctx = (i: number): Ctx => ({ i, seats, climb: cl, left: CLIMBS - c + 1, potPerCoin: POT_RATE * seats.reduce((a, s) => a + s.chips, 0) / seats.length, rand });
    const shopping = () => {
      for (let i = 0; i < bots.length; i++) {
        for (let n = 0; n < 8; n++) {
          const u = bots[i]!.shop(ctx(i));
          if (!u) break;
          const next = buy(seats[i]!, u);
          if (next === seats[i]) break;
          seats[i] = next;
          stats.buys++;
        }
      }
    };
    shopping();
    seats = seats.map((s, i) => ({ ...follow(s, cl, 0), share: bots[i]!.share(ctx(i)) }));
    let at = 0;
    const pass = (to: number) => { seats = seats.map((s) => earn(s, to - at)); at = to; };
    pass(cl.bet);
    seats = seats.map((s) => follow(s, cl, cl.bet));
    while (cl.fell < 0) {
      // Before the next coin: who gets off.
      const odds = nextOdds(cl)!;
      for (let i = 0; i < bots.length; i++) {
        if (seats[i]!.at !== RIDING || bots[i]!.ride(ctx(i), odds)) continue;
        seats[i] = grab(seats[i]!, cl.h);
        if (cl.h > 0) moments[i]!.push(clock + at);
        if (bots[i]!.flip(ctx(i))) {
          seats[i] = flip(seats[i]!, rand());
          stats.flips++;
          if (seats[i]!.flip === 1) moments[i]!.push(clock + at);
        }
      }
      const riders = seats.filter((s) => s.at === RIDING).length;
      const goldBefore = cl.gold.length;
      const potPerCoin = POT_RATE * seats.reduce((a, s) => a + worth(s), 0) / seats.length;
      const next = cl.next;
      cl = climbAt(cl, next, rand, riders, potPerCoin);
      pass(cl.fell >= 0 ? cl.fell : next);
      const before = seats;
      seats = seats.map((s) => follow(s, cl, at));
      if (cl.gold.length > goldBefore) {
        stats.golds++;
        seats.forEach((s, i) => { if (s.gilded > before[i]!.gilded) moments[i]!.push(clock + at); });
      }
      if (cl.fell >= 0) {
        if (cl.h >= TOP) { stats.tops++; seats.forEach((s, i) => { if (before[i]!.at === RIDING) moments[i]!.push(clock + at); }); }
        // A near miss: off the coin before it fell.
        else seats.forEach((s) => { if (s.at === cl.h && s.at > 0) stats.nearMisses++; });
      }
    }
    pass(cl.fell + PAUSE_MS);
    shopping();
    clock += at;
    pot = cl.pot;
    stats.climbs++;
    scores.push(seats.map((s) => s.chips));
    times.push(clock);
  }
  const final = scores[scores.length - 1]!;
  stats.busted += final.filter((v) => v < START_CHIPS).length;
  const top = Math.max(...final);
  const winners = final.flatMap((v, i) => (v === top ? [i] : []));
  return { players: bots.map((b) => b.name), start: bots.map(() => START_CHIPS), scores, times, winner: winners.length === 1 ? winners[0]! : null, moments };
}

const newStats = (): Stats => ({ golds: 0, tops: 0, nearMisses: 0, flips: 0, buys: 0, climbs: 0, busted: 0 });

function matches(n: number, seed: number, table: (rand: () => number, k: number) => Bot[], stats = newStats()): Match[] {
  const rand = seeded(seed);
  return Array.from({ length: n }, (_, k) => play(table(rand, k), rand, stats));
}

/** One against the other, seats swapped every other match: of the matches one of them won, how many the first did. */
function headToHead(a: Bot, b: Bot, n: number, seed: number): number {
  const ms = matches(n, seed, (_r, k) => (k % 2 ? [b, a] : [a, b])).filter((m) => m.winner !== null);
  return ms.filter((m) => m.players[m.winner!] === a.name).length / ms.length;
}

const MIXED = ['novice', 'novice', 'timid', 'reckless', 'steady', 'smart', 'allin', 'random'];

describe('Clink, played by bots: how fun it is, as far as numbers tell (test/fun.ts)', () => {
  it('lands in every band', () => {
    const stats = newStats();
    // Tables of four, the kinds of player drawn at random: what a call of friends might be.
    const mixed = matches(3000, 1, (rand) => Array.from({ length: 4 }, () => BOTS[MIXED[Math.floor(rand() * MIXED.length)]!]!), stats);
    const m = measure(mixed);
    const rates = winRates(mixed);
    const duel = matches(2000, 2, () => [BOTS['smart']!, BOTS['smart']!]);
    const d = measure(duel);
    const fixed = ['random', 'timid', 'reckless', 'allin', 'steady', 'hoarder', 'shopper'];
    const roundRobin = winRates(matches(3000, 3, (rand) => Array.from({ length: 4 }, () => BOTS[fixed[Math.floor(rand() * fixed.length)]!]!)));
    const topFixed = Math.max(...fixed.map((f) => roundRobin[f]!.vsFair));
    const perMatch = (v: number) => v / mixed.length;
    const checks: Check[] = [
      // Skill: thinking pays, luck still matters.
      { name: 'smart beats random, one on one', value: headToHead(BOTS['smart']!, BOTS['random']!, 2000, 4), min: 0.62, max: 0.97, why: 'thinking pays' },
      { name: 'smart beats a novice, one on one', value: headToHead(BOTS['smart']!, BOTS['novice']!, 2000, 7), min: 0.6, max: 0.85, why: 'skill shows, but a new friend wins some' },
      { name: 'smart beats steady (who ignores the table)', value: headToHead(BOTS['smart']!, BOTS['steady']!, 2000, 5), min: 0.5, max: 0.72, why: 'reading the table is worth something' },
      { name: 'buying beats never buying', value: headToHead(BOTS['steady']!, BOTS['hoarder']!, 2000, 6), min: 0.55, max: 0.85, why: 'the shop matters, and is not everything' },
      { name: 'buying some beats buying all', value: headToHead(BOTS['steady']!, BOTS['shopper']!, 2000, 8), min: 0.55, max: 1, why: 'how much to spend is a choice: spending it all loses' },
      { name: 'the best simple strategy, over its fair share', value: topFixed, min: 1, max: 1.9, why: 'no one simple way of playing wins every time' },
      { name: 'staking everything, over its fair share', value: roundRobin['allin']!.vsFair, min: 0.4, max: 1.6, why: 'all in is a choice, not the answer' },
      { name: 'smart at a mixed table, over its fair share', value: rates['smart']!.vsFair, min: 1.1, max: 2.6, why: 'the best play wins most' },
      // Drama (Browne): the lead moves, the end is open, the last climb matters.
      { name: 'lead changes a match (four players)', value: m.leadChanges, min: 1.5, max: 5, why: 'a lead that never moves is dull, one that moves every climb is chaos' },
      { name: 'leader halfway wins (four players)', value: m.leaderAtHalfWins, min: 0.3, max: 0.65, why: 'halfway, it is still open' },
      { name: 'leader at four fifths wins (four players)', value: m.leaderAtFourFifthsWins, min: 0.45, max: 0.82, why: 'a lead late counts for something, not everything' },
      { name: 'winner was last halfway (four players)', value: m.winnerLastAtHalf, min: 0.08, max: 0.35, why: 'a comeback from the bottom happens' },
      { name: 'the lead changes on the last climb', value: m.lastStepTurn, min: 0.12, max: 0.45, why: 'the last climb is worth watching' },
      { name: 'winner was behind at some point', value: m.winnerWasBehind, min: 0.55, max: 0.97, why: 'Browne\'s drama: winners who had to come back' },
      { name: 'where the winner took the lead for good', value: m.decidedAt, min: 0.4, max: 0.85, why: 'decided late, not at the start' },
      { name: 'two good players: leader halfway wins', value: d.leaderAtHalfWins, min: 0.5, max: 0.75, why: 'one on one, still open halfway' },
      { name: 'two good players: lead changes a match', value: d.leadChanges, min: 0.6, max: 4, why: 'one on one, the lead moves (a whole swap each time)' },
      { name: 'runner-up over winner, the median', value: m.closeness, min: 0.2, max: 0.85, why: 'close enough to hurt, far enough to mean something' },
      // Number go up (incremental games): orders of magnitude, for the winner at least.
      { name: 'winner\'s chips over the start (×)', value: m.winnerGrowth, min: 20, max: 1e6, why: 'the winner\'s number grows by orders of magnitude' },
      { name: 'everyone\'s chips over the start (×)', value: m.growth, min: 2, max: 1e4, why: 'most players end with more than they began' },
      { name: 'players ending below their start', value: stats.busted / (mixed.length * 4), min: 0.05, max: 0.4, why: 'losing it all happens, to a few' },
      // Pacing: the next good moment is never far.
      { name: 'seconds between good moments, median', value: m.gapMedianS, min: 4, max: 22, why: 'a win, a gold coin or a double comes often' },
      { name: 'seconds between good moments, 90th %', value: m.gapP90S, min: 10, max: 60, why: 'nobody waits a minute for one' },
      { name: 'seconds to the first good moment, 90th %', value: m.firstMomentP90S, min: 8, max: 45, why: 'a good moment soon after it starts' },
      { name: 'match length, seconds', value: m.lengthS, min: 110, max: 210, why: 'a few minutes: one more match is easy' },
      // The big moments: rare enough to be big.
      { name: 'golden coins a match', value: perMatch(stats.golds), min: 1, max: 6, why: 'a jackpot or two a match' },
      { name: 'matches with a tower to the top', value: perMatch(stats.tops), min: 0.01, max: 0.25, why: 'legendary, seen now and then' },
      { name: 'near misses a match (off the coin before it fell)', value: perMatch(stats.nearMisses), min: 1, max: 12, why: 'a narrow escape or two a match' },
      { name: 'things bought a match', value: perMatch(stats.buys), min: 4, max: 30, why: 'the shop is used' },
    ];
    console.log(report(`Clink, ${mixed.length} matches of four, ${duel.length} duels`, checks));
    console.log('Duels:', d);
    console.log('Win rates at mixed tables (over fair share):', Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, Math.round(v.vsFair * 100) / 100])));
    console.log('Win rates, simple strategies (over fair share):', Object.fromEntries(Object.entries(roundRobin).map(([k, v]) => [k, Math.round(v.vsFair * 100) / 100])));
    expect(checks.filter((c) => !within(c)).map((c) => `${c.name}: ${c.value}`)).toEqual([]);
  }, 120_000);
});
