// Clink, a game (core/game.ts): a tower of coins in the middle of the table, and everyone's chips on it. Coin by coin
// it grows, and what a stake on it pays with it (`MULTS`); any coin may topple it, some more likely than others, and
// everyone sees how likely the next one is. Grab before it falls and your stake comes back multiplied; ride it down and
// it is gone. Now and then a coin lands golden, and pays the pot to everyone still on. Between climbs, what you won
// buys things that make the next ones pay more (`SHOP`); after the last climb, most chips wins.
//
// The towers are every app's own, all the same: a match's seed, chosen by the leader and sent with the round, says from
// its start which coin of each climb topples it, which are golden, how each sits, and when each lands (`scriptOf`), so
// every app works the climbs out for itself (`climbsTo`, `climbAt`); nothing about a tower goes over the wire, and no
// change of leader, lost frame or hidden tab can take back a coin. Everything else is each player's own (`Seat`,
// `follow`): their chips, their stake, when they grabbed, what they bought, sent to the others (`SeatFrame`). A grab is
// judged by the coins its app has seen land. The rounds (here a match of CLIMBS climbs) are the leader's, as in every
// game (core/rounds.ts). Runtime-neutral: plain data only.
import { frameFields, parseRoundFrame, type Phase, type Round, type RoundFrame } from './rounds';

/** Climbs to a match, and what everyone starts it with. */
export const CLIMBS = 10;
export const START_CHIPS = 1000;
/** The most chips anyone can have: the wire takes whole numbers no bigger (core/rounds.ts, `sc`). */
export const MAX_CHIPS = 1e15;
/** The tower's full height: a climb that gets there pays out at its top. */
export const TOP = 20;
/** What a stake pays back, grabbed with this many coins landed: as it was before the first, ×1. */
export const MULTS: readonly number[] = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 4, 5, 6, 7.5, 9, 11, 14, 17, 21, 26, 32, 40, 50, 100];

/** Each climb pays more than the last: what it wins, this much more a climb (the last of a match nearly twice the first). */
export const RAISE = 0.12;
export const raiseOf = (c: number): number => 1 + RAISE * (Math.max(1, Math.min(CLIMBS, c)) - 1);

/** How a coin sits as it comes down: steady, wobbly or shaky, which everyone sees before it lands. */
export type Mood = 0 | 1 | 2;
const MOOD_FACTOR = [0.4, 1, 2.2] as const;
export const moodOf = (roll: number): Mood => (roll < 0.35 ? 0 : roll < 0.75 ? 1 : 2);
/** The chance that coin `k` (1 the first) topples the tower, in percent: more the higher it is, more when it shakes. */
export const odds = (k: number, mood: Mood): number => Math.min(90, Math.max(1, Math.round((6 + 1.3 * k) * MOOD_FACTOR[mood])));
/** A golden coin, the chance any coin that lands is one: it pays the pot to everyone on the tower. */
export const GOLD_CHANCE = 0.06;
/** What each coin that lands adds to the pot, more each climb, as the table's chips grow. */
export const potCoin = (c: number): number => Math.round(20 * 1.22 ** (Math.max(1, Math.min(CLIMBS, c)) - 1));

/** How long the stakes are open before a climb (the first longer, to look around), and how often a coin lands. */
export const BET_MS = 4000;
export const FIRST_BET_MS = 7000;
export const clinkMs = (h: number): number => Math.max(550, 1100 - 30 * h);
/** After a climb ends, before the next opens. */
export const PAUSE_MS = 2600;
export const COUNT_MS = 3500;
export const OVER_MS = 9000;

// The shop: each thing in it has levels, each dearer than the last, and what it does at each level.

export const UPGRADES = ['piggy', 'charm', 'net', 'magnet'] as const;
export type Upgrade = (typeof UPGRADES)[number];
/** What I have of each, in `UPGRADES` order: its level, 0 for none. */
export type Levels = readonly number[];
export const NO_LEVELS: Levels = UPGRADES.map(() => 0);

export const SHOP: Record<Upgrade, { icon: string; name: string; costs: readonly number[]; what: (level: number) => string }> = {
  piggy: { icon: '🐷', name: 'Piggy bank', costs: [500, 4000, 30_000], what: (l) => `What you keep off the tower grows ${Math.round(INTEREST[l]! * 100)}% a climb` },
  charm: { icon: '🍀', name: 'Lucky charm', costs: [600, 3000, 14_000, 60_000], what: (l) => `Grabs win ${Math.round(CHARM[l]! * 100)}% more` },
  net: { icon: '🪂', name: 'Safety net', costs: [800, 4500, 24_000], what: (l) => `Keep ${Math.round(NET[l]! * 100)}% when it falls` },
  magnet: { icon: '🧲', name: 'Magnet', costs: [600, 5000], what: (l) => `Golden coins pay you ×${MAGNET[l]}` },
};
/** Chips everyone gets a second, whatever happens: one who lost it all is back on the tower soon. */
export const ALLOWANCE = 10;
export const INTEREST: readonly number[] = [0, 0.15, 0.3, 0.45];
export const CHARM: readonly number[] = [0, 0.3, 0.7, 1.2, 2];
export const NET: readonly number[] = [0, 0.25, 0.4, 0.55];
/** A double or nothing wins this often. */
export const FLIP_ODDS = 0.5;
export const MAGNET: readonly number[] = [1, 3, 5];

const level = (levels: Levels, u: Upgrade): number => levels[UPGRADES.indexOf(u)] ?? 0;
/** What the next level of `u` costs; null once it has them all. */
export const costOf = (levels: Levels, u: Upgrade): number | null => SHOP[u].costs[level(levels, u)] ?? null;

// The climbs: from the match's seed, the same on every screen.

/**
 * A roll of the match's dice, 0 to 1: for climb `c`, coin `k`, and what it decides (`what`: 1 the coin's mood, 2 whether
 * it topples the tower, 3 whether it is golden). From the seed alone, so the same on every screen.
 */
export type Roll = (c: number, k: number, what: number) => number;
export const rollsOf = (seed: number): Roll => (c, k, what) => {
  let h = (seed ^ Math.imul(c, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b) ^ Math.imul(what + 1, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
export const newSeed = (rand: () => number): number => Math.floor(rand() * 4294967296) >>> 0;

/** A climb as its seed has it from the start. Times are ms after `t0`, when its stakes opened, by this app's clock. */
export type Script = {
  c: number;
  t0: number;
  bet: number;
  /** Each coin's mood, and when it lands, the first's first, up to the one that topples it or the top. */
  moods: Mood[];
  at: number[];
  /** The coin that topples it; TOP + 1 for none, the tower getting to the top. */
  falls: number;
  /** The golden coins that land, and what each pays everyone on. */
  gold: [number, number][];
  /** The pot when it opens, and what is left of it when it is over. */
  potIn: number;
  potOut: number;
  /** When it is over: the toppling coin's landing, or the top's. */
  end: number;
};

/** Climb `c`, opening at `t0`, the pot at `potIn`, from the match's dice; the first of a match gives longer to stake. */
export function scriptOf(rolls: Roll, c: number, t0: number, potIn: number, first: boolean): Script {
  const bet = first ? FIRST_BET_MS : BET_MS;
  const moods: Mood[] = [], at: number[] = [], gold: [number, number][] = [];
  let t = bet, pot = potIn, falls = TOP + 1;
  for (let k = 1; k <= TOP; k++) {
    t += clinkMs(k - 1);
    const mood = moodOf(rolls(c, k, 1));
    moods.push(mood);
    at.push(t);
    if (rolls(c, k, 2) * 100 < odds(k, mood)) { falls = k; break; }
    pot += potCoin(c);
    if (rolls(c, k, 3) < GOLD_CHANCE) { gold.push([k, Math.floor(pot)]); pot = 0; }
  }
  return { c, t0, bet, moods, at, falls, gold, potIn, potOut: pot, end: at[at.length - 1]! };
}

/** A climb as it stands at some moment. Times are ms after `t0`, when its stakes opened. */
export type Climb = {
  /** Which climb of the match, 1 the first (practice climbs while waiting count on). */
  c: number;
  t0: number;
  /** When the stakes close and the first coin starts down. */
  bet: number;
  /** Coins landed. */
  h: number;
  /** Each coin's mood, the first's first: every one landed, and the next. */
  moods: Mood[];
  /** When the next coin lands. */
  next: number;
  /** When the climb ended: the tower fell, or got to the top (`h === TOP`); -1 while it stands. */
  fell: number;
  /** The golden coins landed: which coin, and what it paid everyone on. */
  gold: [number, number][];
  pot: number;
};

/** The climb `ms` after it opened: the coins whose time has come landed, the toppling one's fall once its time has. */
export function climbAt(s: Script, ms: number): Climb {
  let h = 0, pot = s.potIn;
  while (h < s.at.length && h + 1 < s.falls && s.at[h]! <= ms) {
    h++;
    pot = s.gold.some(([k]) => k === h) ? 0 : pot + potCoin(s.c);
  }
  const over = ms >= s.end && (s.falls <= TOP || h >= TOP);
  return { c: s.c, t0: s.t0, bet: s.bet, h, moods: s.moods.slice(0, h + 1), next: s.at[h] ?? s.end, fell: over ? s.end : -1, gold: s.gold.filter(([k]) => k <= h), pot };
}

/**
 * The climb going on at `now`, of the climbs from `since` (a match's, or practice's while waiting): `known`, the
 * climbs worked out so far, carried on as far as `now` needs, each opening a pause after the last is over. Null once
 * the last of `limit` is over and its pause gone by: the match is over.
 */
export function climbsTo(known: Script[], rolls: Roll, since: number, now: number, limit = Infinity): Script | null {
  if (!known.length) known.push(scriptOf(rolls, 1, since, 0, true));
  // A moment before the last one worked out opened: the climb going on then.
  if (now < known[known.length - 1]!.t0) return known.findLast((s) => now >= s.t0) ?? known[0]!;
  for (;;) {
    const s = known[known.length - 1]!;
    if (now < s.t0 + s.end + PAUSE_MS) return s;
    if (s.c >= limit) return null;
    known.push(scriptOf(rolls, s.c + 1, s.t0 + s.end + PAUSE_MS, s.potOut, false));
  }
}

/** The chance the next coin topples it, in percent; null once it is over. */
export const nextOdds = (cl: Climb): number | null => (cl.fell >= 0 ? null : odds(cl.h + 1, cl.moods[cl.h] ?? 1));

// A seat at the table: each player's own.

/** Of a climb, where I am: -1 on the tower; -2 not on it; -3 fell with it; 0 or more, grabbed with that many coins landed. */
export const RIDING = -1, OFF = -2, FELL = -3;
/** How much of my chips I stake: all of them, half, a quarter. */
export type Share = 1 | 2 | 4;

export type Seat = {
  chips: number;
  share: Share;
  levels: Levels;
  /** The climb what follows is of, and whether its stake is in. */
  c: number;
  placed: boolean;
  stake: number;
  at: number;
  /** What my grab paid, and how a double or nothing on it went: 0 not tried, 1 won, -1 lost. */
  won: number;
  flip: 0 | 1 | -1;
  /** Of the climb's golden coins, how many I have counted; and what they paid me. */
  golds: number;
  gilded: number;
  /** What I kept off the tower when the stakes closed, and what the piggy bank paid on it once the climb was over (-1 not yet). */
  kept: number;
  interest: number;
};

export const newSeat = (chips = START_CHIPS): Seat => ({ chips, share: 2, levels: NO_LEVELS, c: 0, placed: false, stake: 0, at: OFF, won: 0, flip: 0, golds: 0, gilded: 0, kept: 0, interest: -1 });

const cap = (v: number): number => Math.max(0, Math.min(MAX_CHIPS, v));

/** What a stake pays grabbed with `h` coins landed in climb `c`: the stake, and its win, more each climb and with a lucky charm. */
export const payout = (stake: number, h: number, levels: Levels, c: number): number =>
  stake * (1 + ((MULTS[h] ?? 1) - 1) * (1 + (CHARM[level(levels, 'charm')] ?? 0)) * raiseOf(c));

/**
 * My seat as the climb goes, `ms` after it opened: a new climb clears the last; the stakes close and mine goes on, if
 * the tower has no coin on it yet (one who comes in later sits that climb out); golden coins pay me while I was on; and
 * when it is over, a stake still on falls with it, all but what a safety net keeps, or, at the top, pays out there.
 */
export function follow(s: Seat, cl: Climb, ms: number): Seat {
  let x = s;
  if (x.c !== cl.c) x = { ...x, c: cl.c, placed: false, stake: 0, at: OFF, won: 0, flip: 0, golds: 0, gilded: 0, kept: 0, interest: -1 };
  if (!x.placed && ms >= cl.bet) {
    const stake = cl.h === 0 && cl.fell < 0 && x.chips >= 1 ? Math.max(1, Math.floor(x.chips / x.share)) : 0;
    x = { ...x, placed: true, stake, chips: x.chips - stake, at: stake > 0 ? RIDING : OFF, kept: x.chips - stake };
  }
  while (x.golds < cl.gold.length) {
    const [k, paid] = cl.gold[x.golds]!;
    const on = x.stake > 0 && (x.at === RIDING || x.at >= k);
    const got = on ? paid * (MAGNET[level(x.levels, 'magnet')] ?? 1) : 0;
    x = { ...x, golds: x.golds + 1, chips: cap(x.chips + got), gilded: x.gilded + got };
  }
  if (x.at === RIDING && cl.fell >= 0) {
    if (cl.h >= TOP) x = grab(x, TOP);
    else x = { ...x, at: FELL, chips: cap(x.chips + x.stake * (NET[level(x.levels, 'net')] ?? 0)) };
  }
  // The piggy bank, once the climb is over: on what I kept, as far as I still have it.
  if (x.placed && x.interest < 0 && cl.fell >= 0) {
    const interest = Math.floor(Math.min(x.kept, x.chips) * (INTEREST[level(x.levels, 'piggy')] ?? 0));
    x = { ...x, interest, chips: cap(x.chips + interest) };
  }
  return x;
}

/** I grab, with `h` coins landed as my app has seen them: my stake comes back, multiplied. */
export function grab(s: Seat, h: number): Seat {
  if (s.at !== RIDING) return s;
  const won = Math.floor(payout(s.stake, Math.max(0, Math.min(TOP, h)), s.levels, s.c));
  return { ...s, at: Math.max(0, Math.min(TOP, h)), won, chips: cap(s.chips + won) };
}

/** What a double or nothing puts at stake: what my grab won over my stake, as far as I still have it. */
export const flipStake = (s: Seat): number => Math.max(0, Math.min(s.won - s.stake, s.chips));

/** Double or nothing, on what my grab just won, once a climb: `roll` under the odds wins it again; my stake is safe. */
export function flip(s: Seat, roll: number): Seat {
  const bet = flipStake(s);
  if (s.at < 0 || s.flip !== 0 || bet <= 0) return s;
  const win = roll < FLIP_ODDS;
  return { ...s, flip: win ? 1 : -1, chips: cap(s.chips + (win ? bet : -bet)) };
}

export const canFlip = (s: Seat): boolean => s.at >= 0 && s.flip === 0 && flipStake(s) > 0;

export function buy(s: Seat, u: Upgrade): Seat {
  const cost = costOf(s.levels, u);
  if (cost === null || s.chips < cost) return s;
  return { ...s, chips: s.chips - cost, levels: s.levels.map((l, i) => (i === UPGRADES.indexOf(u) ? l + 1 : l)) };
}

/** The allowance over `ms`. */
export const earn = (s: Seat, ms: number): Seat => ({ ...s, chips: cap(s.chips + ALLOWANCE * Math.max(0, ms) / 1000) });

// The match: the leader's, as every game's rounds are (core/rounds.ts).

/** A player as the leader counts them: the match they play (`n`, 0 for none), the newest they know, and their chips. */
export type Counted = { who: string; n: number; known: number; chips: number };

/** The round as the leader runs it, and the seed of its climbs (practice's while waiting, the match's while playing). */
export type Lead = { round: Round; seed: number };

/** The order of a round's phases, as one round goes: count, play, over, then waiting (or the next round's count). */
const PHASE_ORDER: Record<Phase, number> = { count: 0, play: 1, over: 2, wait: 3 };
/**
 * Who leads, as a number to rank by (core/rounds.ts, `leaderOf`): who knows the newest round, then the furthest phase of
 * it. A friend back from a while away, who missed a match's end, leads nobody back into it.
 */
export const rankOf = (n: number, phase: Phase): number => n * 4 + PHASE_ORDER[phase];
export const phaseOrder = (phase: Phase): number => PHASE_ORDER[phase];

/**
 * The round at `now`. `heard`: the players the leader hears from (itself too), who start a match; `present`: those and
 * any not heard from lately whose link is still open (away a while), who keep one going. While waiting for a second
 * player, climbs go on for practice. A second starts a match: the countdown, then CLIMBS climbs (`over`, once the last
 * is done: the climbs are the seed's, `climbsTo`); then most chips wins. A match left with one player in it is theirs.
 */
export function advance(t: Lead, now: number, heard: readonly Counted[], present: readonly Counted[], rand: () => number, over: boolean): Lead {
  const r = t.round;
  const ms = now - r.since;
  const enough = heard.length >= 2;
  const count = (n: number): Lead => ({ round: { n, phase: 'count', since: now, players: heard.map((p) => p.who).sort(), winner: null, wins: r.wins }, seed: t.seed });
  switch (r.phase) {
    case 'wait':
      return enough ? count(r.n + 1) : t;
    case 'count':
      if (!enough) return { round: { ...r, phase: 'wait', since: now, players: [] }, seed: newSeed(rand) };
      return ms >= COUNT_MS ? { round: { ...r, phase: 'play', since: now }, seed: newSeed(rand) } : t;
    case 'play': {
      // In it: those who play this match, or have not yet taken it. Gone, or back and watching, is out of it.
      const playing = r.players.map((who) => present.find((h) => h.who === who)).filter((p): p is Counted => p !== undefined && (p.known < r.n || p.n === r.n));
      if (!over && (playing.length >= 2 || r.players.length < 2)) return t;
      const scores = Object.fromEntries(playing.map((p) => [p.who, Math.floor(p.chips)]));
      const winner = playing.reduce<Counted | null>((a, b) => (a === null || b.chips > a.chips ? b : a), null)?.who ?? null;
      return { round: { ...r, phase: 'over', since: now, winner, scores, wins: winner ? { ...r.wins, [winner]: (r.wins[winner] ?? 0) + 1 } : r.wins }, seed: t.seed };
    }
    case 'over':
      if (ms < OVER_MS) return t;
      return enough ? count(r.n + 1) : { round: { n: r.n, phase: 'wait', since: now, players: [], winner: null, wins: r.wins }, seed: newSeed(rand) };
  }
}

// On the wire: as core/rounds.ts says.

/**
 * My seat, from me: `r` the match I play (0 for none), `n` the newest round I know and `po` how far into it
 * (`phaseOrder`); `c` the climb the rest is of; my chips (off the tower), share, stake, where I am on the tower (`a`,
 * as `Seat.at`), what my grab paid, how my double or nothing went, what golden coins paid me, and my levels in the shop.
 */
export type SeatFrame = {
  k: 's'; r: number; n: number; po: number; c: number; ch: number; sh: Share; st: number; a: number; w: number; f: 0 | 1 | -1; g: number; lv: number[];
};
/** The round, from the leader, with its climbs' seed (`s`). */
export type MatchFrame = RoundFrame & { s: number };
export type Frame = SeatFrame | MatchFrame;

export const seatFrame = (s: Seat, r: number, n: number, po: number): SeatFrame => ({
  k: 's', r, n, po, c: s.c, ch: Math.floor(s.chips), sh: s.share, st: Math.floor(s.stake), a: s.at, w: Math.floor(s.won), f: s.flip, g: Math.floor(s.gilded), lv: [...s.levels],
});
export const matchFrame = (f: RoundFrame, seed: number): MatchFrame => ({ ...f, s: seed });

const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const BIG = Number.MAX_SAFE_INTEGER;

/** A frame from another player, or null for anything off. */
export function parseFrame(text: unknown): Frame | null {
  const f = frameFields(text);
  if (!f) return null;
  if (f['k'] === 's') {
    const { r, n, po, c, ch, sh, st, a, w, g, lv } = f;
    const fl = f['f'];
    if (!int(r, 0, BIG) || !int(n, 0, BIG) || !int(po, 0, 3) || !int(c, 0, BIG)) return null;
    if (!int(ch, 0, MAX_CHIPS) || (sh !== 1 && sh !== 2 && sh !== 4) || !int(st, 0, MAX_CHIPS)) return null;
    if (!int(a, FELL, TOP) || !int(w, 0, MAX_CHIPS) || (fl !== 0 && fl !== 1 && fl !== -1) || !int(g, 0, MAX_CHIPS)) return null;
    if (!Array.isArray(lv) || lv.length > 16 || !lv.every((l) => int(l, 0, 16))) return null;
    return { k: 's', r, n, po, c, ch, sh, st, a, w, f: fl, g, lv: lv as number[] };
  }
  if (f['k'] === 'r') {
    const round = parseRoundFrame(f);
    return round && int(f['s'], 0, 4294967295) ? { ...round, s: f['s'] } : null;
  }
  return null;
}

/** What the inspection hooks show of the game (`window.__daveGame`, client/clink.ts). */
export type ClinkView = {
  game: 'clink'; phase: Phase; round: number; leader: string | null; playing: boolean; connected: number;
  climb: { c: number; h: number; fell: boolean; odds: number | null; open: boolean; pot: number; gold: number } | null;
  me: { chips: number; share: Share; stake: number; at: number; won: number; flip: 0 | 1 | -1; levels: number[] };
  others: { key: string; chips: number; at: number; c: number; flip: 0 | 1 | -1 }[];
  scores: Record<string, number> | null; winner: string | null; wins: Record<string, number>;
};

