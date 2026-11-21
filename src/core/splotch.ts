// Splotch, the second game (core/game.ts): every player is a blob of paint on a square board. Wherever a blob goes it
// leaves its colour, over anyone else's; a splat paints a round patch at once, now and then. When the time is up, who has
// the most of the board wins the round.
//
// Every app moves its own blob and sends where it is, and when it last splatted, to every other player many times a
// second (`PaintFrame`); every app paints the board from what it hears, its own blob's path and the others'. So two
// boards may differ by a tile where two blobs crossed at once: the leader's board counts (core/rounds.ts), and its count
// goes out with the round's end. A player of the round leads it before anyone who only watches (`roundLeader`): a
// watcher's board misses what was painted before they came. Runtime-neutral: plain data only.
import { frameFields, num, parseRoundFrame, round2, type Phase, type Round, type RoundFrame } from './rounds';

/** Tiles along each side of the board; the board is that many units wide, its middle at 0. */
export const BOARD = 24;
export const HALF = BOARD / 2;
export const BLOB_RADIUS = 0.6;
/** How wide the trail a blob paints is (its radius), and a splat's. */
export const BRUSH = 0.75;
export const SPLAT_RADIUS = 2.4;
export const SPLAT_COOLDOWN_MS = 3500;
/** How fast a blob goes, and how quickly it gets there: no ice here. */
export const SPEED = 6.5;
export const GRIP = 10;

export const COUNT_MS = 3000;
export const PLAY_MS = 45_000;
export const OVER_MS = 5000;

/**
 * A blob. `splat` names its last splat, by when it was made by its player's clock (ms since 1970; 0 for none): a later
 * splat, from this app or a reloaded one, always names a greater one, so another app paints each splat once, whatever
 * order the frames come in. `splatAt` is when, by this app's clock, for the wait before the next.
 */
export type Blob = { x: number; z: number; vx: number; vz: number; splat: number; splatAt: number };
export const blobAt = (x: number, z: number): Blob => ({ x, z, vx: 0, vz: 0, splat: 0, splatAt: -Infinity });

/** Where a round puts the `i`th of `count` players: evenly round a ring, a little in from the edge. */
export function startAt(i: number, count: number): { x: number; z: number } {
  if (count <= 1) return { x: 0, z: 0 };
  const a = (2 * Math.PI * i) / count - Math.PI / 2;
  const r = HALF * 0.6;
  return { x: Math.round(r * Math.cos(a) * 1000) / 1000, z: Math.round(r * Math.sin(a) * 1000) / 1000 };
}

/** The blob `dt` seconds on, going the way it is steered (`dir`, of at most length 1), kept on the board. */
export function move(b: Blob, dir: { x: number; z: number }, dt: number): Blob {
  const k = Math.min(1, GRIP * dt);
  let vx = b.vx + (dir.x * SPEED - b.vx) * k;
  let vz = b.vz + (dir.z * SPEED - b.vz) * k;
  let x = b.x + vx * dt, z = b.z + vz * dt;
  const edge = HALF - BLOB_RADIUS;
  if (x < -edge || x > edge) { x = Math.max(-edge, Math.min(edge, x)); vx = 0; }
  if (z < -edge || z > edge) { z = Math.max(-edge, Math.min(edge, z)); vz = 0; }
  return { ...b, x, z, vx, vz };
}

export const canSplat = (b: Blob, now: number): boolean => now - b.splatAt >= SPLAT_COOLDOWN_MS;
/** A splat at `now` (this app's clock) and `wall` (ms since 1970), unless the last was too recent. */
export const splat = (b: Blob, now: number, wall: number): Blob => (canSplat(b, now) ? { ...b, splat: Math.max(Math.round(wall), b.splat + 1), splatAt: now } : b);

// The board: who painted each tile last, by the start of their key (core/rounds.ts, `whoOf`); null for nobody yet.
export type Board = (string | null)[];
export const emptyBoard = (): Board => new Array<string | null>(BOARD * BOARD).fill(null);
const index = (tx: number, tz: number): number => tz * BOARD + tx;

/** Paints every tile whose middle is within `r` of (x, z) for `who`; returns the tiles that changed. */
export function paintDisc(board: Board, who: string, x: number, z: number, r: number): number[] {
  const changed: number[] = [];
  const lo = (v: number) => Math.max(0, Math.floor(v - r + HALF));
  const hi = (v: number) => Math.min(BOARD - 1, Math.floor(v + r + HALF));
  for (let tz = lo(z); tz <= hi(z); tz++) {
    for (let tx = lo(x); tx <= hi(x); tx++) {
      const cx = tx - HALF + 0.5, cz = tz - HALF + 0.5;
      if ((cx - x) ** 2 + (cz - z) ** 2 > r * r) continue;
      const i = index(tx, tz);
      if (board[i] !== who) { board[i] = who; changed.push(i); }
    }
  }
  return changed;
}

/** Paints the trail of a blob that went from `from` to `to` for `who`: no gaps however far it went between the two. */
export function paintPath(board: Board, who: string, from: { x: number; z: number }, to: { x: number; z: number }): number[] {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(d / (BRUSH * 0.5)));
  const changed: number[] = [];
  for (let s = 1; s <= steps; s++) changed.push(...paintDisc(board, who, from.x + ((to.x - from.x) * s) / steps, from.z + ((to.z - from.z) * s) / steps, BRUSH));
  return changed;
}

/** How many tiles each player has. */
export function tally(board: Board): Record<string, number> {
  const out: Record<string, number> = {};
  for (const who of board) if (who !== null) out[who] = (out[who] ?? 0) + 1;
  return out;
}

/** Who has the most; null for nobody, or a tie for the most. */
export function winnerOf(scores: Record<string, number>): string | null {
  let best: string | null = null, most = 0, tied = false;
  for (const [who, n] of Object.entries(scores)) {
    if (n > most) { best = who; most = n; tied = false; } else if (n === most && n > 0) tied = true;
  }
  return tied ? null : best;
}

/** A player as the leader counts them: the round they play (`n`, 0 for none) and the newest they know (`known`). */
export type Counted = { who: string; n: number; known: number };

/**
 * The round at `now`, with `here` the players the leader hears from (the leader too) and `board` the leader's. A second
 * player starts a round; the countdown runs to the play; the play runs for PLAY_MS, or until only one of its players is
 * left in it; then the board is counted, the winner shown, and the next round starts, or the wait if one player is left.
 */
export function advance(r: Round, now: number, here: readonly Counted[], board: () => Board): Round {
  const ms = now - r.since;
  const enough = here.length >= 2;
  const count = (n: number): Round => ({ n, phase: 'count', since: now, players: here.map((p) => p.who).sort(), winner: null, wins: r.wins });
  switch (r.phase) {
    case 'wait':
      return enough ? count(r.n + 1) : r;
    case 'count':
      if (!enough) return { ...r, phase: 'wait', since: now, players: [] };
      return ms >= COUNT_MS ? { ...r, phase: 'play', since: now } : r;
    case 'play': {
      // Still in it: one whose app plays the round, or has not yet taken it; gone, or back and watching, is out of it.
      const left = r.players.filter((who) => { const p = here.find((h) => h.who === who); return p !== undefined && (p.known < r.n || p.n === r.n); });
      if (ms < PLAY_MS && left.length > 1) return r;
      const scores = tally(board());
      const winner = winnerOf(scores);
      return { ...r, phase: 'over', since: now, winner, scores, wins: winner ? { ...r.wins, [winner]: (r.wins[winner] ?? 0) + 1 } : r.wins };
    }
    case 'over':
      if (ms < OVER_MS) return r;
      return enough ? count(r.n + 1) : { n: r.n, phase: 'wait', since: now, players: [], winner: null, wins: r.wins };
  }
}

/**
 * Who leads, of the players this app hears from and itself: `known` the newest round each knows, `playing` the round
 * each plays (0 for none), as each one's own frames say. Who knows the newest round, then who plays it (from its
 * countdown, on a board cleared then, through to its end), then the smallest key (core/rounds.ts, `leaderOf`). Only what
 * the players say of themselves counts, never the phase this app is in: every app names the same leader while a phase
 * changes under them, and the leader goes on sending until another one's frames show it holds the round.
 */
export function roundLeader(players: readonly { key: string; known: number; playing: number }[]): string | null {
  let best: (typeof players)[number] | null = null;
  const plays = (p: (typeof players)[number]) => p.playing > 0 && p.playing === p.known;
  for (const p of players) {
    if (best === null || p.known > best.known) { best = p; continue; }
    if (p.known < best.known) continue;
    if (plays(p) !== plays(best)) { if (plays(p)) best = p; continue; }
    if (p.key < best.key) best = p;
  }
  return best?.key ?? null;
}

/** The seconds left of a round's play, shown counting down. */
export const secondsLeft = (phase: Phase, ms: number): number => (phase === 'play' ? Math.max(0, Math.ceil((PLAY_MS - ms) / 1000)) : 0);

// On the wire: as core/rounds.ts says.

/**
 * Where a player's blob is, from that player: `r` the round they play (0 for none: they watch), `n` the newest round they
 * know, `s` their last splat (`Blob.splat`), so a splat whose frame was lost is painted with the next, and an old one
 * that comes late is not painted again.
 */
export type PaintFrame = { k: 'p'; r: number; n: number; x: number; z: number; vx: number; vz: number; s: number };
export type Frame = PaintFrame | RoundFrame;

export const paintFrame = (b: Blob, r: number, n: number): PaintFrame =>
  ({ k: 'p', r, n, x: round2(b.x), z: round2(b.z), vx: round2(b.vx), vz: round2(b.vz), s: b.splat });

/** A frame from another player, or null for anything off. */
export function parseFrame(text: unknown): Frame | null {
  const f = frameFields(text);
  if (!f) return null;
  if (f['k'] === 'p') {
    const { r, n, x, z, vx, vz, s } = f;
    if (!Number.isSafeInteger(r) || (r as number) < 0 || !Number.isSafeInteger(n) || (n as number) < 0 || !num(x, HALF) || !num(z, HALF) || !num(vx, 50) || !num(vz, 50) || !Number.isSafeInteger(s) || (s as number) < 0) return null;
    return { k: 'p', r: r as number, n: n as number, x, z, vx, vz, s: s as number };
  }
  if (f['k'] === 'r') return parseRoundFrame(f);
  return null;
}

/** What the inspection hooks show of the game (`window.__daveGame`, client/splotch.ts). */
export type SplotchView = {
  game: 'splotch'; phase: Phase; round: number; leader: string | null; playing: boolean; connected: number;
  me: { x: number; z: number }; others: { key: string; x: number; z: number }[];
  /** The tiles each player has on this app's board, and the round's as the leader counted it at its end. */
  tiles: Record<string, number>; scores: Record<string, number> | null; winner: string | null; wins: Record<string, number>;
};
