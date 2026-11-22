// Clink, a game (core/game.ts): a tower of coins in the middle of the table, and everyone's chips on it. Coin by coin
// it grows, and what a stake on it pays with it (`MULTS`); any coin may topple it, some more likely than others, and
// everyone sees how likely the next one is. Grab before it falls and your stake comes back multiplied; ride it down and
// it is gone. Now and then a coin lands golden, and pays the pot to everyone still on. Between climbs, what you won
// buys things that make the next ones pay more (`SHOP`); after the last climb, most chips wins.
//
// The tower is the leader's (`Climb`, `climbAt`): it lands every coin, rolls whether it topples, and sends the climb as
// it stands to the others, who follow it. Everything else is each player's own (`Seat`, `follow`): their chips, their
// stake, when they grabbed, what they bought, worked out by their own app and sent to the others (`SeatFrame`). A grab
// is judged by the coins its app had seen land: it pays what they made, never one that had not landed yet. The rounds
// (here a match of CLIMBS climbs) are the leader's too, as in every game (core/rounds.ts). Runtime-neutral: plain data.
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
/** What each coin that lands adds to the pot, as a share of the table's chips, on average. */
export const POT_RATE = 0.02;

/** How long the stakes are open before a climb (the first longer, to look around), and how often a coin lands. */
export const BET_MS = 4000;
export const FIRST_BET_MS = 7000;
export const clinkMs = (h: number): number => Math.max(550, 1100 - 30 * h);
/** Once nobody is on the tower, the coins come down quickly: everyone sees where it would have gone, not for long. */
export const FAST_MS = 280;
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

// The climb: the leader's.

/** A climb as the leader runs it. Times are ms after `t0`, when its stakes opened, by this app's clock. */
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
  /** The golden coins: which coin, and what it paid everyone on. */
  gold: [number, number][];
  pot: number;
};

export const newClimb = (c: number, t0: number, pot: number, roll: number, first = false): Climb => {
  const bet = first ? FIRST_BET_MS : BET_MS;
  return { c, t0, bet, h: 0, moods: [moodOf(roll)], next: bet + clinkMs(0), fell: -1, gold: [], pot };
};

/** The chance the next coin topples it, in percent; null once it is over. */
export const nextOdds = (cl: Climb): number | null => (cl.fell >= 0 ? null : odds(cl.h + 1, cl.moods[cl.h] ?? 1));

/** A coin landed later than this after it was due (a leader's hidden tab, a leader just taken over) counts from then. */
export const LATE_MS = 250;

/**
 * The climb `ms` after it opened, as the leader lands its coins: each in turn, on time, may topple it; one that lands
 * may be golden, while anyone is on (`riders`), and pays them the pot, which every coin landed with someone on adds to
 * (`potPerCoin`). With nobody on, the coins come down quickly to where it falls. A coin that lands late puts the next
 * a whole interval after it, never several down at once: whoever is on gets the time to grab between any two.
 */
export function climbAt(cl: Climb, ms: number, rand: () => number, riders: number, potPerCoin: number): Climb {
  if (cl.fell >= 0 || ms < cl.next) return cl;
  let { h, next, pot, fell } = cl;
  const moods = [...cl.moods], gold = [...cl.gold];
  while (fell < 0 && ms >= next) {
    const at = ms - next > LATE_MS ? ms : next;
    if (rand() * 100 < odds(h + 1, moods[h] ?? 1)) { fell = at; break; }
    h++;
    if (riders > 0) {
      pot += potPerCoin;
      if (rand() < GOLD_CHANCE) { gold.push([h, Math.floor(pot)]); pot = 0; }
    }
    if (h >= TOP) { fell = at; break; }
    moods.push(moodOf(rand()));
    next = at + (riders > 0 ? clinkMs(h) : FAST_MS);
  }
  return { ...cl, h, moods, next, fell, gold, pot };
}

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

/** A player as the leader counts them: the match they play (`n`, 0 for none), the newest they know, chips, on or not. */
export type Counted = { who: string; n: number; known: number; chips: number; riding: boolean };

/** The table as the leader runs it: the round (a match), and the climb going on, if any. */
export type Table = { round: Round; climb: Climb | null };

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : START_CHIPS);

/**
 * The table at `now`, with `here` the players the leader hears from (the leader too). While waiting for a second
 * player, climbs go on for practice. A second starts a match: the countdown, then CLIMBS climbs, the next opening a
 * while after each ends; after the last, most chips wins. A match left with one player in it is theirs.
 */
export function advance(t: Table, now: number, here: readonly Counted[], rand: () => number): Table {
  const r = t.round;
  const ms = now - r.since;
  const enough = here.length >= 2;
  const count = (n: number): Table => ({ round: { n, phase: 'count', since: now, players: here.map((p) => p.who).sort(), winner: null, wins: r.wins }, climb: null });
  // The climb, of these players: its coins, and the next once it has been over a while.
  const climbing = (players: readonly Counted[], practice: boolean): Climb | 'done' => {
    let cl = t.climb ?? newClimb(1, now, 0, rand(), true);
    const potPerCoin = POT_RATE * mean(players.map((p) => p.chips));
    cl = climbAt(cl, now - cl.t0, rand, players.filter((p) => p.riding).length, potPerCoin);
    if (cl.fell >= 0 && now - cl.t0 >= cl.fell + PAUSE_MS) {
      if (!practice && cl.c >= CLIMBS) return 'done';
      return newClimb(cl.c + 1, now, cl.pot, rand());
    }
    return cl;
  };
  switch (r.phase) {
    case 'wait': {
      if (enough) return count(r.n + 1);
      const cl = climbing(here, true);
      return { round: r, climb: cl === 'done' ? null : cl };
    }
    case 'count':
      if (!enough) return { round: { ...r, phase: 'wait', since: now, players: [] }, climb: null };
      return ms >= COUNT_MS ? { round: { ...r, phase: 'play', since: now }, climb: newClimb(1, now, 0, rand(), true) } : t;
    case 'play': {
      // In it: those who play this match, or have not yet taken it. Gone, or back and watching, is out of it.
      const playing = r.players.map((who) => here.find((h) => h.who === who)).filter((p): p is Counted => p !== undefined && (p.known < r.n || p.n === r.n));
      const cl = playing.length >= 2 || r.players.length < 2 ? climbing(playing, false) : 'done';
      if (cl !== 'done') return { round: r, climb: cl };
      const scores = Object.fromEntries(playing.map((p) => [p.who, Math.floor(p.chips)]));
      const winner = playing.reduce<Counted | null>((a, b) => (a === null || b.chips > a.chips ? b : a), null)?.who ?? null;
      return { round: { ...r, phase: 'over', since: now, winner, scores, wins: winner ? { ...r.wins, [winner]: (r.wins[winner] ?? 0) + 1 } : r.wins }, climb: null };
    }
    case 'over':
      if (ms < OVER_MS) return t;
      return enough ? count(r.n + 1) : { round: { n: r.n, phase: 'wait', since: now, players: [], winner: null, wins: r.wins }, climb: null };
  }
}

// On the wire: as core/rounds.ts says.

/**
 * My seat, from me: `r` the match I play (0 for none), `n` the newest I know; `kc` the climb of it I know (0 for none),
 * and `v` whether I may lead (core/clinktable.ts, `rankOf`); `c` the climb the rest is of; my chips, share, stake, where
 * I am on the tower (`a`, as `Seat.at`), what my grab paid, how my double or nothing went, what golden coins paid me,
 * and my levels in the shop.
 */
export type SeatFrame = {
  k: 's'; r: number; n: number; kc: number; v: boolean; c: number; ch: number; sh: Share; st: number; a: number; w: number; f: 0 | 1 | -1; g: number; lv: number[];
};
/** The climb, from the leader: as `Climb`, `t` ms after it opened; `q` orders the leader's frames (core/rounds.ts). */
export type ClimbFrame = { k: 'c'; q: number; n: number; c: number; t: number; b: number; h: number; m: Mood[]; nx: number; fl: number; gd: [number, number][]; pot: number };
export type Frame = SeatFrame | ClimbFrame | RoundFrame;

export const seatFrame = (s: Seat, r: number, n: number, kc: number, v: boolean): SeatFrame => ({
  k: 's', r, n, kc, v, c: s.c, ch: Math.floor(s.chips), sh: s.share, st: Math.floor(s.stake), a: s.at, w: Math.floor(s.won), f: s.flip, g: Math.floor(s.gilded), lv: [...s.levels],
});
export const climbFrame = (cl: Climb, n: number, now: number, q: number): ClimbFrame => ({
  k: 'c', q, n, c: cl.c, t: Math.max(0, Math.round(now - cl.t0)), b: cl.bet, h: cl.h, m: [...cl.moods], nx: cl.next, fl: cl.fell, gd: cl.gold.map(([k, p]) => [k, p]), pot: Math.floor(cl.pot),
});
/** The climb a follower takes from the leader's frame, heard at `now` by its own clock. */
export const climbOf = (f: ClimbFrame, now: number): Climb => ({ c: f.c, t0: now - f.t, bet: f.b, h: f.h, moods: f.m, next: f.nx, fell: f.fl, gold: f.gd, pot: f.pot });

const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const BIG = Number.MAX_SAFE_INTEGER;
const LONG_MS = 3_600_000;

/** A frame from another player, or null for anything off. */
export function parseFrame(text: unknown): Frame | null {
  const f = frameFields(text);
  if (!f) return null;
  if (f['k'] === 's') {
    const { r, n, kc, v, c, ch, sh, st, a, w, g, lv } = f;
    const fl = f['f'];
    if (!int(r, 0, BIG) || !int(n, 0, BIG) || !int(kc, 0, BIG) || typeof v !== 'boolean' || !int(c, 0, BIG)) return null;
    if (!int(ch, 0, MAX_CHIPS) || (sh !== 1 && sh !== 2 && sh !== 4) || !int(st, 0, MAX_CHIPS)) return null;
    if (!int(a, FELL, TOP) || !int(w, 0, MAX_CHIPS) || (fl !== 0 && fl !== 1 && fl !== -1) || !int(g, 0, MAX_CHIPS)) return null;
    if (!Array.isArray(lv) || lv.length > 16 || !lv.every((l) => int(l, 0, 16))) return null;
    return { k: 's', r, n, kc, v, c, ch, sh, st, a, w, f: fl, g, lv: lv as number[] };
  }
  if (f['k'] === 'c') {
    const { q, n, c, t, b, h, m, nx, fl, gd, pot } = f;
    if (!int(q, 0, BIG) || !int(n, 0, BIG) || !int(c, 0, BIG) || !int(t, 0, LONG_MS) || !int(b, 0, 60_000) || !int(h, 0, TOP)) return null;
    if (!Array.isArray(m) || m.length < 1 || m.length > TOP + 1 || !m.every((x) => x === 0 || x === 1 || x === 2)) return null;
    if (!int(nx, 0, LONG_MS) || !int(fl, -1, LONG_MS) || !int(pot, 0, MAX_CHIPS)) return null;
    if (!Array.isArray(gd) || gd.length > TOP || !gd.every((e: unknown) => Array.isArray(e) && e.length === 2 && int(e[0], 1, TOP) && int(e[1], 0, MAX_CHIPS))) return null;
    return { k: 'c', q, n, c, t, b, h, m: m as Mood[], nx, fl, gd: gd as [number, number][], pot };
  }
  if (f['k'] === 'r') return parseRoundFrame(f);
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

