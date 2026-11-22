// How fun a game plays, as far as numbers can tell: many matches played by bots, and what they show. A game's own test
// plays the matches with its own rules (test/clink.fun.test.ts) and hands them here as `Match`es; `measure` reads them,
// and `report` sets each measure against the band it should fall in, with why.
//
// What is measured comes from how games have been judged by simulation: Browne's drama and lead changes (an eventual
// winner who spent a while behind; a lead that changes hands, but not on every move), the outcome uncertain until late,
// and a comeback possible; from agent playtesting, skill as the gap between a thoughtful bot and a random one, with no
// one simple strategy that beats all others; from incremental games, numbers that grow by orders of magnitude, and a
// next good moment never far off. None of it says a game is fun; a game that misses these bands is very likely not.

/** A seeded random, 0 to 1 (mulberry32): the same matches every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One match, as a game's simulation played it. */
export type Match = {
  /** Who played, by strategy: one each. */
  players: string[];
  /** Each player's score at the start; after each step of the match (a climb, a lap), the last the final; and when each step ended. */
  start: number[];
  scores: number[][];
  times: number[];
  /** Who won, by index; null for nobody. */
  winner: number | null;
  /** Each player's good moments, ms into the match: a win, a jackpot, whatever the game calls one. */
  moments: number[][];
};

const leaderOf = (row: number[]): number => row.reduce((best, v, i) => (v > row[best]! ? i : best), 0);
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))]!;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const share = (xs: boolean[]): number => (xs.length ? xs.filter(Boolean).length / xs.length : NaN);

export type Measures = {
  matches: number;
  /** Times the lead changed hands, a match, on average. */
  leadChanges: number;
  /** The leader halfway through, and four fifths through, won: how often. */
  leaderAtHalfWins: number;
  leaderAtFourFifthsWins: number;
  /** The winner was last halfway through (three or more players): how often. */
  winnerLastAtHalf: number;
  /** The lead changed on the last step: how often. */
  lastStepTurn: number;
  /** How far into the match the winner took the lead for good, on average (0 the start, 1 the end). */
  decidedAt: number;
  /** Browne's drama: of matches whose winner was ever behind after the first step, the share. */
  winnerWasBehind: number;
  /** The runner-up's final score over the winner's, the median: close to 1 is a close finish. */
  closeness: number;
  /** Final over first score: the winner's, and everyone's, the median. */
  winnerGrowth: number;
  growth: number;
  /** Seconds between a player's good moments, the median and the 90th percentile; the longest wait at the start. */
  gapMedianS: number;
  gapP90S: number;
  firstMomentP90S: number;
  /** A match's length, the median, seconds. */
  lengthS: number;
};

export function measure(matches: Match[]): Measures {
  const turns: number[] = [], half: boolean[] = [], fourFifths: boolean[] = [], lastAtHalf: boolean[] = [], lastTurn: boolean[] = [];
  const decided: number[] = [], behind: boolean[] = [], close: number[] = [], winnerGrowth: number[] = [], growth: number[] = [];
  const gaps: number[] = [], firsts: number[] = [], lengths: number[] = [];
  for (const m of matches) {
    const steps = m.scores.length;
    const leaders = m.scores.map(leaderOf);
    let changes = 0;
    for (let i = 1; i < steps; i++) if (leaders[i] !== leaders[i - 1]) changes++;
    turns.push(changes);
    lengths.push(m.times[steps - 1]! / 1000);
    const first = m.start;
    for (let p = 0; p < m.players.length; p++) growth.push(m.scores[steps - 1]![p]! / Math.max(1, first[p]!));
    for (let p = 0; p < m.players.length; p++) {
      let t = 0;
      for (const at of m.moments[p]!) { gaps.push((at - t) / 1000); t = at; }
      firsts.push((m.moments[p]![0] ?? m.times[steps - 1]!) / 1000);
    }
    if (m.winner === null) continue;
    const w = m.winner;
    half.push(leaders[Math.floor((steps - 1) / 2)] === w);
    fourFifths.push(leaders[Math.floor((steps - 1) * 0.8)] === w);
    if (m.players.length >= 3) {
      const mid = m.scores[Math.floor((steps - 1) / 2)]!;
      lastAtHalf.push(mid[w] === Math.min(...mid));
    }
    lastTurn.push(steps >= 2 && leaders[steps - 1] !== leaders[steps - 2]);
    let from = steps - 1;
    while (from > 0 && leaders[from - 1] === w) from--;
    decided.push(from / steps);
    behind.push(leaders.slice(1).some((l) => l !== w));
    const final = [...m.scores[steps - 1]!].sort((a, b) => b - a);
    close.push(final.length > 1 ? final[1]! / Math.max(1, final[0]!) : 1);
    winnerGrowth.push(m.scores[steps - 1]![w]! / Math.max(1, first[w]!));
  }
  return {
    matches: matches.length,
    leadChanges: mean(turns),
    leaderAtHalfWins: share(half),
    leaderAtFourFifthsWins: share(fourFifths),
    winnerLastAtHalf: share(lastAtHalf),
    lastStepTurn: share(lastTurn),
    decidedAt: mean(decided),
    winnerWasBehind: share(behind),
    closeness: quantile(close, 0.5),
    winnerGrowth: quantile(winnerGrowth, 0.5),
    growth: quantile(growth, 0.5),
    gapMedianS: quantile(gaps, 0.5),
    gapP90S: quantile(gaps, 0.9),
    firstMomentP90S: quantile(firsts, 0.9),
    lengthS: quantile(lengths, 0.5),
  };
}

/** How often each strategy won, of the matches it played: wins over matches played, and over its fair share. */
export function winRates(matches: Match[]): Record<string, { played: number; won: number; rate: number; vsFair: number }> {
  const out: Record<string, { played: number; won: number; fair: number }> = {};
  for (const m of matches) {
    for (let p = 0; p < m.players.length; p++) {
      const s = (out[m.players[p]!] ??= { played: 0, won: 0, fair: 0 });
      s.played++;
      s.fair += 1 / m.players.length;
      if (m.winner === p) s.won++;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { played: v.played, won: v.won, rate: v.won / v.played, vsFair: v.won / v.fair }]));
}

/** A measure and the band it should be in, and why. */
export type Check = { name: string; value: number; min: number; max: number; why: string };
export const within = (c: Check): boolean => c.value >= c.min && c.value <= c.max;

const fmt = (v: number): string => (Number.isNaN(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/** The checks as a table to read: each measure, its band, in it or not, and why it should be. */
export function report(title: string, checks: Check[]): string {
  const rows = checks.map((c) => `${within(c) ? '✓' : '✗'} ${c.name.padEnd(44)} ${fmt(c.value).padStart(8)}   in ${fmt(c.min)}..${fmt(c.max)}   ${c.why}`);
  return [`${title}`, ...rows].join('\n');
}
