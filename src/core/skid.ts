// Skid, the third game (core/game.ts): a kart race, three laps of a winding track. Every player drives a kart with their
// face in it; drifting round a bend charges a boost, boost pads and turbos speed you up, an oil slick dropped behind you
// spins whoever drives over it.
//
// Every app drives its own kart and sends where it is, its lap and how far round, and when it finished, to every other
// player many times a second (`KartFrame`). Karts push each other apart, each its own. Item boxes are each app's own; an
// oil slick goes out in its dropper's frames, and each app spins its own kart on it. The race is the leader's, as every
// round is (core/rounds.ts): it ends once everyone in it finished, or a while after the first did; the order goes out
// with its end. Runtime-neutral: plain data only.
import { frameFields, num, parseRoundFrame, round2, type Phase, type Round, type RoundFrame } from './rounds';

// The track: a closed loop through these points, smoothed (Catmull-Rom), as a line of points along its middle.
const CONTROL: readonly [number, number][] = [
  [-40, 42], [0, 46], [40, 42], [62, 22], [58, -4], [32, -14], [22, -34], [42, -54], [12, -68], [-24, -58], [-34, -32],
  [-60, -22], [-68, 8], [-58, 32],
];
const PER_SEGMENT = 18;
export const TRACK_WIDTH = 10;
export const LAPS = 3;

export type Point = { x: number; z: number };
/** The middle of the track, every point of it, and how far along it each is (`at`, units); `length` the whole loop. */
export type Track = { points: Point[]; at: number[]; length: number };

function catmull(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) };
}

export function makeTrack(control: readonly [number, number][] = CONTROL): Track {
  const c = control.map(([x, z]) => ({ x, z }));
  const points: Point[] = [];
  for (let i = 0; i < c.length; i++) {
    const p = (k: number) => c[(k + c.length) % c.length]!;
    for (let s = 0; s < PER_SEGMENT; s++) points.push(catmull(p(i - 1), p(i), p(i + 1), p(i + 2), s / PER_SEGMENT));
  }
  const at: number[] = [0];
  for (let i = 1; i < points.length; i++) at.push(at[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  const last = points[points.length - 1]!, first = points[0]!;
  return { points, at, length: at[at.length - 1]! + Math.hypot(first.x - last.x, first.z - last.z) };
}
export const TRACK = makeTrack();

/**
 * Where on the track a spot is: how far round (`progress`, 0 to 1 from the start line), how far from its middle
 * (`side`, units, negative to the left as the track goes), and the track's direction there (`dir`, radians).
 */
export function locate(x: number, z: number, track: Track = TRACK): { progress: number; side: number; dir: number } {
  const n = track.points.length;
  let best = { d: Infinity, s: 0, side: 0, dir: 0 };
  for (let i = 0; i < n; i++) {
    const a = track.points[i]!, b = track.points[(i + 1) % n]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const px = a.x + dx * t, pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const len = Math.sqrt(len2);
      // Left of the way the track goes is negative: the cross product of its direction and the offset.
      const side = ((dx * (z - a.z) - dz * (x - a.x)) / len) > 0 ? d : -d;
      best = { d, s: track.at[i]! + len * t, side, dir: Math.atan2(dz, dx) };
    }
  }
  return { progress: best.s / track.length, side: best.side, dir: best.dir };
}

/** The point `s` units round the track from the start line, and its direction there. */
export function pointAt(s: number, track: Track = TRACK): { x: number; z: number; dir: number } {
  const L = track.length;
  const u = ((s % L) + L) % L;
  const n = track.points.length;
  let i = 0;
  while (i < n - 1 && track.at[i + 1]! <= u) i++;
  const a = track.points[i]!, b = track.points[(i + 1) % n]!;
  const seg = (i === n - 1 ? L : track.at[i + 1]!) - track.at[i]!;
  const t = seg > 0 ? (u - track.at[i]!) / seg : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dir: Math.atan2(b.z - a.z, b.x - a.x) };
}

/** Where the race puts the `i`th kart: two by two behind the start line, facing along the track. */
export function gridAt(i: number, track: Track = TRACK): { x: number; z: number; h: number } {
  const row = Math.floor(i / 2), lane = i % 2 === 0 ? -1 : 1;
  const p = pointAt(-5 - row * 4.5, track);
  // Left of the direction (cos, sin) is (sin, -cos): see `locate`.
  const off = lane * 2.4;
  return { x: p.x + Math.sin(p.dir) * off, z: p.z - Math.cos(p.dir) * off, h: p.dir };
}

// Driving.

export const MAX_SPEED = 24;
export const GRASS_SPEED = 11;
export const BOOST_SPEED = 34;
export const ACCEL = 16;
export const BRAKE = 34;
export const REVERSE_SPEED = 8;
export const TURN = 2.3;
export const KART_RADIUS = 1.2;
/** A drift held this long (s) gives a boost when let go, longer for a longer drift (to DRIFT_MAX). */
export const DRIFT_CHARGE = 0.7;
export const DRIFT_MAX = 2;
export const SPIN_MS = 1300;
export const SLICK_RADIUS = 1.6;
export const SLICK_LIFE_MS = 20_000;

export type Item = 'turbo' | 'slick';

/**
 * A kart as its player's app drives it. `h` is where it faces (radians: x grows with cos, z with sin), `v` its speed
 * (negative backing up). `lap` counts from 1; `next` is the next of the three checkpoints round the lap it must pass,
 * 3 when all are passed and the line counts. Times are by this app's clock (ms).
 */
export type Kart = {
  x: number; z: number; h: number; v: number;
  lap: number; next: number; progress: number;
  /** The race's time (ms since the go) it finished at; null until it does. */
  finished: number | null;
  drift: 0 | 1 | -1; charge: number;
  boostUntil: number; spinUntil: number;
  item: Item | null;
};

export function kartAt(i: number, track: Track = TRACK): Kart {
  const g = gridAt(i, track);
  return { x: g.x, z: g.z, h: g.h, v: 0, lap: 1, next: 0, progress: locate(g.x, g.z, track).progress, finished: null, drift: 0, charge: 0, boostUntil: 0, spinUntil: 0, item: null };
}

/** What the player does: throttle (-1 brakes and backs up, 1 full), steer (-1 left, 1 right), and a drift held. */
export type Controls = { throttle: number; steer: number; drift: boolean };

const CHECKPOINTS = [0.25, 0.5, 0.75];

/**
 * The kart `dt` seconds on at `now`, as the player drives it, round the track; `raceMs` is the race's time, for its
 * finish. On the grass it is slow; boosting, fast; spun, it neither steers nor speeds up. A drift (held while steering
 * at speed) turns tighter and charges; let go, it boosts. The lap counts at the line once all checkpoints are passed.
 */
export function drive(k: Kart, c: Controls, dt: number, now: number, raceMs: number, track: Track = TRACK): Kart {
  if (k.finished !== null) c = { throttle: 0, steer: 0, drift: false };
  const spun = now < k.spinUntil;
  const boosting = now < k.boostUntil;
  const where = locate(k.x, k.z, track);
  const grass = Math.abs(where.side) > TRACK_WIDTH / 2;
  const top = boosting ? BOOST_SPEED : grass ? GRASS_SPEED : MAX_SPEED;
  let v = k.v;
  const throttle = spun ? 0 : c.throttle;
  if (boosting) v = Math.min(top, v + 40 * dt);
  else if (throttle > 0) v = v < 0 ? v + BRAKE * dt : Math.min(Math.max(v, top * throttle), v + ACCEL * throttle * dt);
  else if (throttle < 0) v = v > 0 ? Math.max(0, v - BRAKE * dt * -throttle) : Math.max(-REVERSE_SPEED, v - ACCEL * 0.6 * -throttle * dt);
  else v *= Math.exp(-0.9 * dt);
  // Past what the ground allows (off the road, a boost run out): it slows to it.
  if (v > top) v = Math.max(top, v - 26 * dt);

  // Drifting: begun with the drift held while steering at speed, kept while held, the way it began.
  let drift = k.drift, charge = k.charge, boostUntil = k.boostUntil;
  if (!spun && c.drift && drift === 0 && Math.abs(c.steer) > 0.3 && v > 10) { drift = c.steer > 0 ? 1 : -1; charge = 0; }
  if (drift !== 0 && (!c.drift || spun || v < 6)) {
    if (charge >= DRIFT_CHARGE && !spun) boostUntil = Math.max(boostUntil, now + 450 + Math.min(charge, DRIFT_MAX) * 400);
    drift = 0;
    charge = 0;
  }
  if (drift !== 0) charge += dt;
  // Steering: as fast as the kart goes, up to TURN; a drift turns tighter, its way, and a little the other way at most.
  const grip = Math.min(1, Math.abs(v) / 8) * Math.sign(v);
  const steer = spun ? 0 : drift !== 0 ? drift * 0.75 + c.steer * 0.55 : c.steer;
  const h = k.h + steer * TURN * (drift !== 0 ? 1.25 : 1) * grip * dt;
  const x = k.x + Math.cos(h) * v * dt, z = k.z + Math.sin(h) * v * dt;

  // The lap: checkpoints in order, then the line, forward.
  const now_ = locate(x, z, track);
  let { lap, next } = k;
  let finished = k.finished;
  if (next < CHECKPOINTS.length && now_.progress >= CHECKPOINTS[next]! && now_.progress < CHECKPOINTS[next]! + 0.1) next++;
  if (k.progress > 0.9 && now_.progress < 0.1 && next === CHECKPOINTS.length) {
    lap++;
    next = 0;
    if (lap > LAPS && finished === null) finished = Math.max(0, Math.round(raceMs));
  }
  return { ...k, x, z, h, v, drift, charge, boostUntil, lap, next, progress: now_.progress, finished };
}

/** A boost, now: from a pad or a turbo. */
export const boost = (k: Kart, now: number, ms = 1000): Kart => ({ ...k, boostUntil: Math.max(k.boostUntil, now + ms) });
/** Spun out on a slick: most of its speed gone, no steering for a moment, any drift lost. */
export const spin = (k: Kart, now: number): Kart => ({ ...k, v: k.v * 0.35, spinUntil: now + SPIN_MS, drift: 0, charge: 0 });

/** My kart pushed out of another, half the overlap (the other app pushes its own the other half); a bump costs speed. */
export function bump(k: Kart, other: { x: number; z: number }): Kart {
  const dx = k.x - other.x, dz = k.z - other.z;
  const d = Math.hypot(dx, dz);
  if (d >= 2 * KART_RADIUS) return k;
  const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
  const push = (2 * KART_RADIUS - d) / 2;
  const into = -(Math.cos(k.h) * nx + Math.sin(k.h) * nz) * Math.sign(k.v);
  return { ...k, x: k.x + nx * push, z: k.z + nz * push, v: into > 0.3 ? k.v * 0.85 : k.v };
}

/** Where the boost pads are (how far round) and the item boxes (how far round, how far from the middle). */
export const PADS: readonly number[] = [0.12, 0.47, 0.8];
export const BOXES: readonly { at: number; side: number }[] = [0.3, 0.62, 0.92].flatMap((at) => [-3, 0, 3].map((side) => ({ at, side })));
export const BOX_RADIUS = 1.8;
export const BOX_BACK_MS = 4000;
export const PAD_LENGTH = 0.012;

/** Where an item box is on the ground. */
export function boxAt(i: number, track: Track = TRACK): Point {
  const b = BOXES[i]!;
  const p = pointAt(b.at * track.length, track);
  return { x: p.x + Math.sin(p.dir) * b.side, z: p.z - Math.cos(p.dir) * b.side };
}

/** Whether a kart where it is on the track (`locate`) is on a boost pad. */
export const onPad = (progress: number, side: number): boolean => Math.abs(side) < TRACK_WIDTH / 2 - 1 && PADS.some((p) => progress >= p && progress < p + PAD_LENGTH);

/** What an item box gives: a turbo more often than a slick. `roll` is a random number from 0 to 1. */
export const itemOf = (roll: number): Item => (roll < 0.6 ? 'turbo' : 'slick');

// The race's places.

/** How far a kart is round the race: laps done and how far round this one. */
export const distance = (k: { lap: number; progress: number; next: number }): number => (k.lap - 1) + (k.next === 0 && k.progress > 0.9 ? k.progress - 1 : k.progress);

/** The order of a race: finished first, by their time; then the furthest round. */
export function standings<T extends { lap: number; progress: number; next: number; finished: number | null }>(karts: readonly T[]): T[] {
  return [...karts].sort((a, b) => {
    if (a.finished !== null || b.finished !== null) return a.finished === null ? 1 : b.finished === null ? -1 : a.finished - b.finished;
    return distance(b) - distance(a);
  });
}

// The rounds.

export const COUNT_MS = 3500;
/** Once the first has finished, the others have this long; and no race goes on longer than MAX_RACE_MS. */
export const GRACE_MS = 25_000;
export const MAX_RACE_MS = 300_000;
export const OVER_MS = 8000;

/** A player as the leader counts them: the round they race (`n`, 0 for none), the newest they know, and their finish. */
export type Counted = { who: string; n: number; known: number; finished: number | null };

/**
 * The race at `now`, with `here` the players the leader hears from (the leader too). A second player starts one; the
 * countdown runs to the go; the race runs until everyone in it has finished, or GRACE_MS after the first did, or for
 * MAX_RACE_MS; then the finishers' times are its score, the fastest wins, and the next race starts, or the wait.
 */
export function advance(r: Round, now: number, here: readonly Counted[]): Round {
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
      // In it: those who race this round, or have not yet taken it. Gone, or back and watching, is out of it.
      const racing = r.players.map((who) => here.find((h) => h.who === who)).filter((p): p is Counted => p !== undefined && (p.known < r.n || p.n === r.n));
      const done = racing.filter((p) => p.n === r.n && p.finished !== null);
      const first = Math.min(...done.map((p) => p.finished!));
      const over = racing.length === 0 || done.length === racing.length || (done.length > 0 && ms >= first + GRACE_MS) || ms >= MAX_RACE_MS || (racing.length < 2 && done.length === 0 && r.players.length > 1);
      if (!over) return r;
      const scores = Object.fromEntries(done.map((p) => [p.who, p.finished!]));
      const winner = done.length > 0 ? done.reduce((a, b) => (b.finished! < a.finished! ? b : a)).who : null;
      return { ...r, phase: 'over', since: now, winner, scores, wins: winner ? { ...r.wins, [winner]: (r.wins[winner] ?? 0) + 1 } : r.wins };
    }
    case 'over':
      if (ms < OVER_MS) return r;
      return enough ? count(r.n + 1) : { n: r.n, phase: 'wait', since: now, players: [], winner: null, wins: r.wins };
  }
}

// On the wire: as core/rounds.ts says.

/**
 * Where a player's kart is, from that player: `r` the round they race (0 for none), `n` the newest they know; its place,
 * heading and speed; its lap, next checkpoint and how far round; `f` its finish (race ms; -1 for not yet); `d` drifting
 * which way, `b` boosting, `sp` spun; `s` the oil slick it dropped last, `[x, z, id]`, or null.
 */
export type KartFrame = {
  k: 'k'; r: number; n: number; x: number; z: number; h: number; v: number; lap: number; next: number; p: number; f: number;
  d: -1 | 0 | 1; b: boolean; sp: boolean; s: [number, number, number] | null;
};
export type Frame = KartFrame | RoundFrame;

export const kartFrame = (k: Kart, r: number, n: number, now: number, slick: [number, number, number] | null): KartFrame => ({
  k: 'k', r, n, x: round2(k.x), z: round2(k.z), h: Math.round(k.h * 1000) / 1000, v: round2(k.v), lap: k.lap, next: k.next, p: Math.round(k.progress * 10000) / 10000,
  f: k.finished ?? -1, d: k.drift, b: now < k.boostUntil, sp: now < k.spinUntil, s: slick,
});

const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** A frame from another player, or null for anything off. */
export function parseFrame(text: unknown): Frame | null {
  const f = frameFields(text);
  if (!f) return null;
  if (f['k'] === 'k') {
    const { r, n, x, z, h, v, lap, next, p, d, b, sp, s } = f;
    const fin = f['f'];
    if (!int(r, 0, Number.MAX_SAFE_INTEGER) || !int(n, 0, Number.MAX_SAFE_INTEGER) || !num(x, 500) || !num(z, 500) || !num(h, 1e6) || !num(v, 100)) return null;
    if (!int(lap, 0, LAPS + 2) || !int(next, 0, CHECKPOINTS.length) || !num(p, 1) || (p as number) < 0 || !int(fin, -1, MAX_RACE_MS * 2)) return null;
    if ((d !== -1 && d !== 0 && d !== 1) || typeof b !== 'boolean' || typeof sp !== 'boolean') return null;
    if (s !== null && (!Array.isArray(s) || s.length !== 3 || !num(s[0], 500) || !num(s[1], 500) || !int(s[2], 0, Number.MAX_SAFE_INTEGER))) return null;
    return { k: 'k', r: r as number, n: n as number, x, z, h, v, lap: lap as number, next: next as number, p: p as number, f: fin as number, d, b, sp, s: s as [number, number, number] | null };
  }
  if (f['k'] === 'r') return parseRoundFrame(f);
  return null;
}

/** What the inspection hooks show of the game (`window.__daveGame`, client/skid.ts). */
export type SkidView = {
  game: 'skid'; phase: Phase; round: number; leader: string | null; playing: boolean; connected: number;
  me: { x: number; z: number; v: number; lap: number; progress: number; finished: number | null; item: Item | null; spun: boolean; boosting: boolean };
  others: { key: string; x: number; z: number; lap: number; progress: number; finished: number | null }[];
  /** My place in the race (1 first), the race's time (ms), and its result once over: each finisher's time. */
  place: number; raceMs: number; scores: Record<string, number> | null; winner: string | null; wins: Record<string, number>;
};
