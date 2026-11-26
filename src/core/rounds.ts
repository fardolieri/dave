// The rounds of a game (core/game.ts, ADR 0014), as every game plays them: one player's app, the leader, runs them, and
// sends the round as it stands (`RoundFrame`) to the others, who follow it; another takes over where it was when the
// leader leaves. What ends a round is each game's own (core/bonk.ts, core/clink.ts). Runtime-neutral: plain data only.

/** What a game is doing: waiting for a second player, counting down to a round, playing one, or showing who won it. */
export type Phase = 'wait' | 'count' | 'play' | 'over';
export const PHASES: readonly Phase[] = ['wait', 'count', 'play', 'over'];

/** How much of a player's key the game's frames carry: enough to tell friends apart (core/party.ts does the same). */
export const WHO_LENGTH = 11;
export const whoOf = (key: string): string => key.slice(0, WHO_LENGTH);
const WHO = new RegExp(`^[A-Za-z0-9_-]{${WHO_LENGTH}}$`);
export const isWho = (v: unknown): v is string => typeof v === 'string' && WHO.test(v);
/** Players a round takes at most, as a call does (ADR 0001 tolerates eight), with room to spare. */
export const MAX_PLAYERS = 16;

/** The round as the leader runs it. `since` is when its phase began, by this app's clock. */
export type Round = {
  n: number;
  phase: Phase;
  since: number;
  /** Who plays round `n`, in the order the game puts them at the start. */
  players: string[];
  /** Who won the round just over; null for nobody, or for a tie. */
  winner: string | null;
  /**
   * Who shared the round just over, in a game that has ties (core/bonk.ts, TIE_MS): the last ones left, fallen together,
   * each given a win. Left out for none.
   */
  tied?: string[];
  /** Rounds each player has won in this game. */
  wins: Record<string, number>;
  /** The round's own score, as the leader counted it at its end, for a game that keeps one; none for one that does not. */
  scores?: Record<string, number>;
};

export const firstRound = (now: number): Round => ({ n: 0, phase: 'wait', since: now, players: [], winner: null, wins: {} });

/**
 * The leader, of those this app hears from, itself included, each with the newest round they know (`n`): who knows the
 * newest, then the smallest key. A player who just came in knows none, and leads nobody until the leader's round
 * reaches them: then they may take over, from where it is.
 */
export const leaderOf = (players: Iterable<{ key: string; n: number }>): string | null => {
  let best: { key: string; n: number } | null = null;
  for (const p of players) if (best === null || p.n > best.n || (p.n === best.n && p.key < best.key)) best = p;
  return best?.key ?? null;
};

// On the wire, between players (client/gamelinks.ts): JSON, small, many times a second, on a channel that may drop or
// reorder any of them. Every field is checked: a friend's app may be another version, or broken.

/**
 * The round as the leader has it: `t` ms into its phase, its players, its winner, everyone's wins, and the round's score
 * where the game keeps one (`sc`), and who tied for it (`ti`, left out for none: an app from before ties reads a tie as
 * nobody's, and the wins as they are). `q` orders the leader's frames, by its clock: one that comes after a later one (the
 * channel keeps no order) is dropped.
 */
export type RoundFrame = { k: 'r'; q: number; n: number; ph: Phase; t: number; ps: string[]; w: string | null; wins: [string, number][]; sc?: [string, number][]; ti?: string[] };

const BOUND = 1000;
export const num = (v: unknown, bound = BOUND): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= bound;
export const round2 = (v: number): number => Math.round(v * 100) / 100;

export const roundFrame = (r: Round, now: number, q: number): RoundFrame =>
  ({ k: 'r', q, n: r.n, ph: r.phase, t: Math.max(0, Math.round(now - r.since)), ps: r.players, w: r.winner, wins: Object.entries(r.wins), ...(r.scores ? { sc: Object.entries(r.scores) } : {}), ...(r.tied?.length ? { ti: r.tied } : {}) });

const tally = (v: unknown): v is [string, number][] =>
  Array.isArray(v) && v.length <= 64 && v.every((e: unknown) => Array.isArray(e) && e.length === 2 && isWho(e[0]) && Number.isSafeInteger(e[1]) && (e[1] as number) >= 0);

/** A round frame, of a frame parsed from JSON whose `k` is `r`; null for anything off. */
export function parseRoundFrame(f: Record<string, unknown>): RoundFrame | null {
  const { q, n, ph, t, ps, w, wins, sc } = f;
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(n) || (n as number) < 0 || !PHASES.includes(ph as Phase) || !Number.isSafeInteger(t) || (t as number) < 0) return null;
  if (!Array.isArray(ps) || ps.length > MAX_PLAYERS || !ps.every(isWho)) return null;
  if (w !== null && !isWho(w)) return null;
  if (!tally(wins) || (sc !== undefined && !tally(sc))) return null;
  // A tie that is off is left out, not the round with it.
  const ti = Array.isArray(f['ti']) && f['ti'].length <= MAX_PLAYERS && f['ti'].every(isWho) ? (f['ti'] as string[]) : undefined;
  return { k: 'r', q: q as number, n: n as number, ph: ph as Phase, t: t as number, ps: ps as string[], w: w as string | null, wins, ...(sc ? { sc } : {}), ...(ti ? { ti } : {}) };
}

/** The round a follower takes from the leader's frame, heard at `now` by its own clock. */
export const roundOf = (f: RoundFrame, now: number): Round =>
  ({ n: f.n, phase: f.ph, since: now - f.t, players: f.ps, winner: f.w, wins: Object.fromEntries(f.wins), ...(f.sc ? { scores: Object.fromEntries(f.sc) } : {}), ...(f.ti ? { tied: f.ti } : {}) });

/** A JSON frame from another player, its fields not yet checked; null for anything that is not one. */
export function frameFields(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > 4096) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
