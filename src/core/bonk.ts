// Bonk, the first game (core/game.ts): every player is a ball with their face on it, on an ice floe in the sea. Roll,
// dash, bonk the others off; the floe shrinks while a round goes on, and the last one on it wins the round.
//
// Every app moves its own ball and nobody else's, and sends where it is to every other player many times a second
// (`BallFrame`); the app whose ball runs into another works the bonk out and gives the other ball its knock (`HitFrame`).
// The rounds are the leader's, as in every game (core/rounds.ts); what ends one here is the floe. Runtime-neutral: plain
// data only.
import { firstRound, frameFields, isWho, leaderOf, num, parseRoundFrame, round2, roundFrame, roundOf, whoOf, MAX_PLAYERS, WHO_LENGTH, type Phase, type Round, type RoundFrame } from './rounds';
// The rounds are every game's (core/rounds.ts); Bonk's are said here too, as they were before there were two games.
export { firstRound, leaderOf, roundFrame, roundOf, whoOf, MAX_PLAYERS, WHO_LENGTH, type Phase, type Round, type RoundFrame };

/** A ball's radius, and the floe's at the start of a round and where it stops shrinking, in the game's units. */
export const BALL_RADIUS = 0.85;
export const FLOE_START = 9;
export const FLOE_MID = 3.2;
/** How hard a player rolls their ball (units/s²), and the fastest they roll it by themselves. */
export const ACCEL = 15;
export const MAX_ROLL = 7.5;
/** How quickly a ball slows by itself, per second: ice, so slowly. */
export const DRAG = 0.9;
/** A dash: this fast, at once, then not again for a while. */
export const DASH_SPEED = 15;
export const DASH_COOLDOWN_MS = 1400;
/** How much a bonk gives back: more than it took, so a bonk sends a ball flying. */
export const BOUNCE = 1.35;
export const GRAVITY = 24;
/** How far a ball falls before it is gone. */
export const SUNK_Y = -8;
/** How long a ball that fell off waits before it comes back, between rounds. */
export const RESPAWN_MS = 1200;

/** How long the countdown before a round lasts, and how long the winner is shown after it. */
export const COUNT_MS = 3000;
export const OVER_MS = 4000;
/** While a round plays: the floe stays whole for a moment, shrinks to FLOE_MID, then on to nothing, so every round ends. */
export const SHRINK_FROM_MS = 5000;
export const SHRINK_MID_MS = 45_000;
export const SHRINK_END_MS = 65_000;

/** The floe's radius, `ms` into a phase; after a round, as it was when the round ended (`ended`). */
export function floeRadius(phase: Phase, ms: number, ended = FLOE_START): number {
  if (phase !== 'play') return phase === 'over' ? ended : FLOE_START;
  if (ms <= SHRINK_FROM_MS) return FLOE_START;
  if (ms <= SHRINK_MID_MS) return FLOE_START + ((FLOE_MID - FLOE_START) * (ms - SHRINK_FROM_MS)) / (SHRINK_MID_MS - SHRINK_FROM_MS);
  return Math.max(0, FLOE_MID * (1 - (ms - SHRINK_MID_MS) / (SHRINK_END_MS - SHRINK_MID_MS)));
}

/** A ball as its player's app moves it. `y` is its height: 0 on the floe, below once it fell off. */
export type Ball = {
  x: number; z: number; vx: number; vz: number;
  y: number; vy: number;
  /** On the floe, and in the round (or rolling around between rounds). */
  alive: boolean;
  /** When it last dashed, by its app's clock (ms); -Infinity for never. */
  dashAt: number;
};

export const ballAt = (x: number, z: number): Ball => ({ x, z, vx: 0, vz: 0, y: 0, vy: 0, alive: true, dashAt: -Infinity });

/** Another player's ball as this app last heard of it. */
export type Seen = { x: number; z: number; vx: number; vz: number; alive: boolean };

/** Where a round puts the `i`th of `count` players: evenly round a ring, facing in. */
export function spawnAt(i: number, count: number): { x: number; z: number } {
  if (count <= 1) return { x: 0, z: 0 };
  const a = (2 * Math.PI * i) / count - Math.PI / 2;
  const r = FLOE_START * 0.6;
  return { x: Math.round(r * Math.cos(a) * 1000) / 1000, z: Math.round(r * Math.sin(a) * 1000) / 1000 };
}

/** The direction a player steers in, of at most length 1: keys give one of eight, a stick anything in between. */
export function steer(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z);
  return l > 1 ? { x: x / l, z: z / l } : { x, z };
}

/**
 * Steering toward a spot on the floe the mouse is held on: for the speed that gets there, full on from afar
 * and slower the nearer it is, so the ball brakes and stops there instead of sliding past and swinging round it, as it
 * would on ice. `ball` is where it is and how fast it goes.
 */
export function toward(ball: { x: number; z: number; vx: number; vz: number }, to: { x: number; z: number }): { x: number; z: number } {
  const dx = to.x - ball.x, dz = to.z - ball.z;
  const d = Math.hypot(dx, dz);
  const want = d < 1e-6 ? 0 : Math.min(MAX_ROLL, d * 2.5) / d;
  return steer((dx * want - ball.vx) / 3, (dz * want - ball.vz) / 3);
}

/** Whether a ball can dash at `now`. */
export const canDash = (b: Ball, now: number): boolean => b.alive && now - b.dashAt >= DASH_COOLDOWN_MS;

/**
 * A dash at `now`: off at DASH_SPEED in the direction steered, or straight on without one; nothing while it cannot. A
 * ball standing still with nothing steered stays put.
 */
export function dash(b: Ball, dir: { x: number; z: number }, now: number): Ball {
  if (!canDash(b, now)) return b;
  let dx = dir.x, dz = dir.z;
  if (Math.hypot(dx, dz) < 0.1) { dx = b.vx; dz = b.vz; }
  const l = Math.hypot(dx, dz);
  if (l < 0.1) return b;
  return { ...b, vx: (dx / l) * Math.max(DASH_SPEED, Math.hypot(b.vx, b.vz)), vz: (dz / l) * Math.max(DASH_SPEED, Math.hypot(b.vx, b.vz)), dashAt: now };
}

/**
 * The ball `dt` seconds on: rolled the way it is steered (to MAX_ROLL; faster only by a dash or a bonk, which then slow
 * by themselves), slowed by the ice. Off the floe (`floe`, its radius) it falls, and is out.
 */
export function roll(b: Ball, dir: { x: number; z: number }, dt: number, floe: number): Ball {
  if (!b.alive) {
    if (b.y <= SUNK_Y) return b;
    const vy = b.vy - GRAVITY * dt;
    return { ...b, x: b.x + b.vx * dt, z: b.z + b.vz * dt, vx: b.vx * 0.98, vz: b.vz * 0.98, vy, y: Math.max(SUNK_Y, b.y + vy * dt) };
  }
  const was = Math.hypot(b.vx, b.vz);
  let vx = b.vx + dir.x * ACCEL * dt;
  let vz = b.vz + dir.z * ACCEL * dt;
  const speed = Math.hypot(vx, vz);
  const cap = Math.max(was, MAX_ROLL);
  if (speed > cap) { vx = (vx / speed) * cap; vz = (vz / speed) * cap; }
  const slow = Math.exp(-DRAG * dt);
  vx *= slow; vz *= slow;
  const x = b.x + vx * dt, z = b.z + vz * dt;
  // Off once its middle is past the edge: half of it hangs over the water, and over it goes.
  if (!(Math.hypot(x, z) <= floe)) return { ...b, x, z, vx, vz, alive: false, vy: 0 };
  return { ...b, x, z, vx, vz };
}

/**
 * My ball after it met `other`: pushed out of it, and, while the two come at each other, given the other's speed along
 * the line between them, and more (BOUNCE). `knock` is what the other ball gets of the same bonk, the change in its
 * speed, which only its own app can give it (`HitFrame`): by the time the other app hears where my ball is, mine has
 * bounced off already, and it would see the two touch, never meet. Returns how hard they met too (0 for not at all),
 * for the sound and the shake.
 */
export function bonk(me: Ball, other: Seen): { ball: Ball; hit: number; knock: { vx: number; vz: number } } {
  const none = { vx: 0, vz: 0 };
  if (!me.alive || !other.alive) return { ball: me, hit: 0, knock: none };
  const dx = other.x - me.x, dz = other.z - me.z;
  const d = Math.hypot(dx, dz);
  if (d >= 2 * BALL_RADIUS) return { ball: me, hit: 0, knock: none };
  // Right on top of each other, which hardly happens: apart along x.
  const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
  const push = (2 * BALL_RADIUS - d) / 2;
  const x = me.x - nx * push, z = me.z - nz * push;
  const mine = me.vx * nx + me.vz * nz;
  const theirs = other.vx * nx + other.vz * nz;
  // Moving apart already: only pushed out.
  if (mine - theirs <= 0) return { ball: { ...me, x, z }, hit: 0, knock: none };
  // Of two equal masses, mine along the line becomes theirs and theirs mine, and the difference is given back BOUNCE
  // times: what one loses the other gets.
  const mid = (mine + theirs) / 2, apart = (BOUNCE * (mine - theirs)) / 2;
  const change = mid - apart - mine;
  const knock = mid + apart - theirs;
  return { ball: { ...me, x, z, vx: me.vx + change * nx, vz: me.vz + change * nz }, hit: mine - theirs, knock: { vx: knock * nx, vz: knock * nz } };
}

/** A bonk another player's app worked out, given to my ball: `knock`, the change in its speed (`bonk`). */
export const knocked = (b: Ball, knock: { vx: number; vz: number }): Ball => (b.alive ? { ...b, vx: b.vx + knock.vx, vz: b.vz + knock.vz } : b);

/**
 * How long after a bonk between two balls another between the same two is not taken: both apps may work out the same
 * bonk, each from where it sees the other, and send it; the first one taken counts.
 */
export const BONK_AGAIN_MS = 250;

/**
 * Where another player's ball is `ageMs` after this app last heard of it: on as it was going, for a quarter of a second
 * at most. Unheard of for longer, it waits where it was.
 */
export const ahead = (s: Seen, ageMs: number): Seen => {
  const t = Math.min(Math.max(0, ageMs), 250) / 1000;
  return { ...s, x: s.x + s.vx * t, z: s.z + s.vz * t };
};

// The rounds.

/**
 * A player as the leader counts them: by the start of their key, the round they play (`n`, 0 for none: they watch), the
 * newest round they know (`known`), and whether they are on the floe.
 */
export type Counted = { who: string; n: number; known: number; alive: boolean };

/** What the inspection hooks show of the game (`window.__daveGame`, client/bonk.ts). */
export type GameView = {
  phase: Phase; round: number; leader: string | null; playing: boolean; spectating: boolean; webgl: boolean;
  me: { x: number; z: number; alive: boolean; lastDash: { vx: number; vz: number } | null }; aim: { x: number; z: number } | null; others: { key: string; x: number; z: number; alive: boolean }[]; wins: Record<string, number>; connected: number;
};

/**
 * The round at `now`, with `here` the players the leader hears from (the leader too). A second player starts a round;
 * the countdown runs to the play; the play runs until one player or none is left on the floe; the winner is shown, and
 * the next round starts, or the wait if only one player is left. A player who came in after the countdown watches.
 */
export function advance(r: Round, now: number, here: readonly Counted[]): Round {
  const ms = now - r.since;
  const enough = here.length >= 2;
  const count = (n: number): Round => ({ ...r, n, phase: 'count', since: now, players: here.map((p) => p.who).sort(), winner: null });
  switch (r.phase) {
    case 'wait':
      return enough ? count(r.n + 1) : r;
    case 'count': {
      if (!enough) return { ...r, phase: 'wait', since: now, players: [] };
      return ms >= COUNT_MS ? { ...r, phase: 'play', since: now } : r;
    }
    case 'play': {
      // Gone from the game counts as fallen, and so does one who came back and only watches (a reload); one whose app
      // has not yet taken the round stands on it still.
      const standing = r.players.filter((who) => { const p = here.find((h) => h.who === who); return p !== undefined && (p.known < r.n || (p.n === r.n && p.alive)); });
      if (standing.length > 1) return r;
      const winner = standing[0] ?? null;
      return { ...r, phase: 'over', since: now, winner, wins: winner ? { ...r.wins, [winner]: (r.wins[winner] ?? 0) + 1 } : r.wins };
    }
    case 'over':
      if (ms < OVER_MS) return r;
      return enough ? count(r.n + 1) : { ...r, phase: 'wait', since: now, players: [], winner: null };
  }
}

// On the wire: as core/rounds.ts says.

/**
 * Where a player's ball is, from that player: `r` the round they play (0 for none: they watch), `n` the newest round
 * they know (core `leaderOf`). `a`: on the floe; `d`: dashed just now.
 */
export type BallFrame = { k: 'b'; r: number; n: number; x: number; z: number; vx: number; vz: number; y: number; a: boolean; d: boolean };
/** A bonk my app worked out, for the ball of `to` (the start of its key): the change in its speed (`bonk`, `knock`). */
export type HitFrame = { k: 'h'; to: string; vx: number; vz: number; hit: number };
export type Frame = BallFrame | RoundFrame | HitFrame;

export const ballFrame = (b: Ball, r: number, n: number, dashed: boolean): BallFrame =>
  ({ k: 'b', r, n, x: round2(b.x), z: round2(b.z), vx: round2(b.vx), vz: round2(b.vz), y: round2(b.y), a: b.alive, d: dashed });

export const hitFrame = (to: string, knock: { vx: number; vz: number }, hit: number): HitFrame =>
  ({ k: 'h', to: whoOf(to), vx: round2(knock.vx), vz: round2(knock.vz), hit: round2(hit) });

/** A frame from another player, or null for anything off. */
export function parseFrame(text: unknown): Frame | null {
  const f = frameFields(text);
  if (!f) return null;
  if (f['k'] === 'b') {
    const { r, n, x, z, vx, vz, y, a, d } = f;
    if (!Number.isSafeInteger(r) || (r as number) < 0 || !Number.isSafeInteger(n) || (n as number) < 0 || !num(x) || !num(z) || !num(vx) || !num(vz) || !num(y) || typeof a !== 'boolean' || typeof d !== 'boolean') return null;
    return { k: 'b', r: r as number, n: n as number, x, z, vx, vz, y, a, d };
  }
  if (f['k'] === 'h') {
    const { to, vx, vz, hit } = f;
    if (!isWho(to) || !num(vx, 100) || !num(vz, 100) || !num(hit, 100) || (hit as number) < 0) return null;
    return { k: 'h', to, vx, vz, hit: hit as number };
  }
  if (f['k'] === 'r') return parseRoundFrame(f);
  return null;
}
