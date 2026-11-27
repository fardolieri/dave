// Bonk's maps (core/bonk.ts): what a round is played on. The ice floe it always was, and others: a star, a square, a
// hexagon, with a cone to roll up, ridges to jump off, pillars to bounce off that stand or go round. Five rounds on each
// (ROUNDS_PER_MAP), then the next, by the round's number, so every app plays the same map with no word about it on the
// wire. Now and then a hole opens in the floe and wanders over it slowly (`holePlan`), on some maps in every round: a ball
// that rolls over it falls through.
//
// A map is drawn at its full size, and shrinks with the floe as a round goes on (core `floeRadius`): its outline, its
// slopes and its hole alike. Its pillars stand where they are, as wide, so a ball still gets between them, and go down
// into the sea once the edge passes under them. What moves on it moves by the round's play clock (core `playClock`),
// which every app has from the leader, so every app has it in the same place, near enough.
// Runtime-neutral: plain data only.
import { BALL_RADIUS, FLOE_START, STILL, spawnAt, type Ground, type Pillar } from './bonk';

type Spot = { x: number; z: number };

/** A cone, as high as `h` in its middle, of radius `r`: rolled up, slowly, and down the other side, fast. */
type Cone = { kind: 'cone'; x: number; z: number; r: number; h: number };
/**
 * A ridge `length` long and `width` wide, lying at `angle` (radians from x toward z), `h` high along its middle and down
 * to the floe at its sides, and at its ends over its last RIDGE_TAPER: rolled fast across it, a ball jumps off its top.
 */
type Ridge = { kind: 'ridge'; x: number; z: number; angle: number; length: number; width: number; h: number };
export type Rise = Cone | Ridge;
/**
 * A pillar of radius `r` at `x`, `z`, at the start of the play. It stands still, or once every `ms` it swings out by `sx`,
 * `sz` and back the other way, or goes round the middle of the floe (`orbit`, 1 for one way, -1 for the other).
 */
export type Post = { x: number; z: number; r: number; ms?: number; sx?: number; sz?: number; orbit?: 1 | -1 };

export type BonkMap = {
  id: string; name: string; mark: string;
  /** Its outline's corners, going round, at full size; none for the round floe of radius FLOE_START. */
  outline: readonly Spot[] | null;
  rises: readonly Rise[];
  posts: readonly Post[];
  /** How far out the players start, round its middle (core `spawnAt`): where it is flat, and clear of the pillars. */
  seat: number;
  /** A hole opens in every round on it, early, not only now and then (`holePlan`). */
  holey?: boolean;
};

/** How many rounds are played on a map before the next. */
export const ROUNDS_PER_MAP = 5;
const RIDGE_TAPER = 1.5;

/** A regular shape of `n` corners `r` from its middle, the first straight ahead (toward -z, away from the camera). */
const regular = (n: number, r: number, turn = 0): Spot[] =>
  Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + turn + (2 * Math.PI * i) / n; return { x: round3(r * Math.cos(a)), z: round3(r * Math.sin(a)) }; });
/** A star of `n` points, `outer` from its middle at their tips and `inner` between them. */
const star = (n: number, outer: number, inner: number): Spot[] =>
  Array.from({ length: 2 * n }, (_, i) => { const a = -Math.PI / 2 + (Math.PI * i) / n, r = i % 2 ? inner : outer; return { x: round3(r * Math.cos(a)), z: round3(r * Math.sin(a)) }; });
const round3 = (v: number) => Math.round(v * 1000) / 1000;
/** `n` pillars evenly round the middle, `at` from it, starting `turn` from straight ahead. */
const ring = (n: number, at: number, post: Omit<Post, 'x' | 'z'>, turn = 0): Post[] =>
  regular(n, at, turn).map((p) => ({ ...p, ...post }));

/** The maps, in the order they come. The floe it always was comes last. */
export const MAPS: readonly BonkMap[] = [
  { id: 'star', name: 'Star', mark: '⭐', outline: star(5, 11, 6.4), rises: [{ kind: 'cone', x: 0, z: 0, r: 2.8, h: 1.3 }], posts: [], seat: 5 },
  {
    id: 'square', name: 'Square', mark: '🟦', outline: regular(4, 8 * Math.SQRT2, Math.PI / 4), seat: 5.4,
    rises: [{ kind: 'cone', x: 0, z: 0, r: 3, h: 1.4 }],
    posts: ring(4, 5.8 * Math.SQRT2, { r: 0.8 }, Math.PI / 4),
  },
  { id: 'volcano', name: 'Volcano', mark: '🌋', outline: null, rises: [{ kind: 'cone', x: 0, z: 0, r: 4.4, h: 2.6 }], posts: [], seat: 6 },
  {
    id: 'bumpers', name: 'Bumpers', mark: '🔴', outline: regular(6, 10), seat: 5.4, rises: [],
    // The inner ring wide enough apart for a ball to get through to a mystery ball in the middle.
    posts: [...ring(5, 3, { r: 0.7, ms: 14_000, orbit: 1 }), ...ring(6, 7.6, { r: 0.75 }, Math.PI / 6)],
  },
  {
    id: 'ramps', name: 'Ramps', mark: '⛷️', outline: regular(4, 8.5 * Math.SQRT2, Math.PI / 4), seat: 6.6, posts: [],
    rises: [0, 1, 2].map((i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / 3;
      return { kind: 'ridge', x: round3(2.6 * Math.cos(a)), z: round3(2.6 * Math.sin(a)), angle: a + Math.PI / 2, length: 6.5, width: 3.2, h: 0.9 };
    }),
  },
  {
    id: 'sinkhole', name: 'Sinkhole', mark: '🕳️', outline: null, seat: 5.4, rises: [], holey: true,
    posts: regular(3, 7.4, Math.PI / 3).map((p) => ({ ...p, r: 0.8, ms: 6000, sx: round3(-p.z / 7.4 * 1.5), sz: round3(p.x / 7.4 * 1.5) })),
  },
  {
    id: 'carousel', name: 'Carousel', mark: '🎠', outline: regular(8, 9.6, Math.PI / 8), seat: 5.6,
    rises: [{ kind: 'cone', x: 0, z: 0, r: 1.8, h: 0.7 }],
    posts: ring(4, 3, { r: 0.9, ms: 10_000, orbit: -1 }),
  },
  {
    id: 'triangle', name: 'Triangle', mark: '🔺', outline: regular(3, 11.5), seat: 4.4, rises: [],
    posts: regular(3, 7.5).map((p) => ({ ...p, r: 0.8, ms: 5000, sx: round3(p.x / 7.5 * 1.2), sz: round3(p.z / 7.5 * 1.2) })),
  },
  { id: 'floe', name: 'Ice floe', mark: '🧊', outline: null, rises: [], posts: [], seat: FLOE_START * 0.6 },
];

/** How far out from its middle a map reaches at its full size: the camera keeps all of it in sight. */
export const reachOf = (map: BonkMap): number => (map.outline ? Math.max(...map.outline.map((p) => Math.hypot(p.x, p.z))) : FLOE_START);

/** The map round `n` is played on: five rounds on each, in turn; the first before any round. */
export const mapOf = (n: number): BonkMap => MAPS[Math.floor((Math.max(1, n) - 1) / ROUNDS_PER_MAP) % MAPS.length]!;
/** Which of its rounds on its map round `n` is, from 1. */
export const roundOnMap = (n: number): number => ((Math.max(1, n) - 1) % ROUNDS_PER_MAP) + 1;

/** Where the `i`th of `count` players starts on `map`: evenly round its seat, as on the floe (core `spawnAt`); one alone, at the first. */
export function seatOn(map: BonkMap, i: number, count: number): Spot {
  // Alone, between rounds, at the first seat: the middle may be a cone.
  const p = count <= 1 ? spawnAt(0, 2) : spawnAt(i, count), k = map.seat / (FLOE_START * 0.6);
  return { x: round3(p.x * k), z: round3(p.z * k) };
}

/** Whether a spot is inside an outline (its corners going round), by how many of its sides a line out from it crosses. */
function inside(outline: readonly Spot[], x: number, z: number): boolean {
  let odd = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]!, b = outline[j]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) odd = !odd;
  }
  return odd;
}

/** How high a rise is at a spot, at full size, and which way it rises there. */
function riseAt(r: Rise, x: number, z: number): { h: number; gx: number; gz: number } {
  const flat = { h: 0, gx: 0, gz: 0 };
  if (r.kind === 'cone') {
    const dx = x - r.x, dz = z - r.z, d = Math.hypot(dx, dz);
    if (d >= r.r) return flat;
    const k = d > 1e-6 ? -r.h / r.r / d : 0;
    return { h: r.h * (1 - d / r.r), gx: dx * k, gz: dz * k };
  }
  // Along the ridge (u) and across it (w).
  const c = Math.cos(r.angle), s = Math.sin(r.angle), dx = x - r.x, dz = z - r.z;
  const u = dx * c + dz * s, w = -dx * s + dz * c, half = r.width / 2, ends = r.length / 2 - Math.abs(u);
  if (Math.abs(w) >= half || ends <= 0) return flat;
  const across = 1 - Math.abs(w) / half, along = Math.min(1, ends / RIDGE_TAPER);
  const dw = (-r.h * along * Math.sign(w)) / half, du = ends < RIDGE_TAPER ? (-r.h * across * Math.sign(u)) / RIDGE_TAPER : 0;
  return { h: r.h * across * along, gx: du * c - dw * s, gz: du * s + dw * c };
}
/** The highest rise at a spot, at full size: where two meet, the higher is the one rolled on. */
function heightOn(map: BonkMap, x: number, z: number): { h: number; gx: number; gz: number } {
  let best = { h: 0, gx: 0, gz: 0 };
  for (const r of map.rises) { const at = riseAt(r, x, z); if (at.h > best.h) best = at; }
  return best;
}

/** How high `map` is at a spot, at full size: for drawing it. */
export const riseOf = (map: BonkMap, x: number, z: number): number => heightOn(map, x, z).h;

/** Where a pillar is `ms` into the play, at full size, and how fast it moves (units/s). */
export function postAt(p: Post, ms: number): Pillar {
  if (!p.ms) return { x: p.x, z: p.z, r: p.r, vx: 0, vz: 0 };
  const w = (2 * Math.PI) / (p.ms / 1000), a = (w * ms) / 1000;
  if (p.orbit) {
    const t = a * p.orbit, c = Math.cos(t), s = Math.sin(t);
    const x = p.x * c - p.z * s, z = p.x * s + p.z * c;
    return { x, z, r: p.r, vx: -z * w * p.orbit, vz: x * w * p.orbit };
  }
  const sin = Math.sin(a), cos = Math.cos(a);
  return { x: p.x + (p.sx ?? 0) * sin, z: p.z + (p.sz ?? 0) * sin, r: p.r, vx: (p.sx ?? 0) * w * cos, vz: (p.sz ?? 0) * w * cos };
}

/** A hole in the floe, where it is and how wide. */
export type Hole = { x: number; z: number; r: number };
/** How wide a hole opens on the whole floe (it shrinks with it), and how long it takes to. */
export const HOLE_R = 1.6;
export const HOLE_OPEN_MS = 2000;
/** How many rounds in a hundred get a hole, on a map that is not holey, and when in the play it opens, at the soonest and latest. */
export const HOLE_CHANCE = 0.4;
const HOLE_FROM_MS = 6000;
const HOLE_TO_MS = 20_000;
/** When it opens on a holey map. */
const HOLE_EARLY_MS = 2000;

/**
 * A round's hole: when in the play it opens (by the play clock, ms), and the way it wanders, two slow swings on each axis
 * (`a` how far, `w` how fast, radians a second, `p` where it starts). Null for a round with none.
 */
export type HolePlan = { from: number; swings: { a: number; w: number; p: number }[][] };

/** A string's hash, as a seed (FNV-1a). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Numbers in [0, 1), the same ones from the same seed on every app (mulberry32). */
function draws(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round `n`'s hole on `map`, played by `players`: drawn from those alone, so every app draws the same one. */
export function holePlan(map: BonkMap, n: number, players: readonly string[]): HolePlan | null {
  const random = draws(hash(`${n}|${players.join(',')}`));
  const chance = random();
  if (!map.holey && chance >= HOLE_CHANCE) return null;
  const from = map.holey ? HOLE_EARLY_MS : HOLE_FROM_MS + random() * (HOLE_TO_MS - HOLE_FROM_MS);
  const swing = (a: number, s: number) => ({ a: a * (0.6 + 0.4 * random()), w: (2 * Math.PI) / (s * (1 + 0.7 * random())), p: random() * 2 * Math.PI });
  return { from: Math.round(from), swings: [[swing(3.5, 20), swing(2, 11)], [swing(3.5, 20), swing(2, 11)]] };
}

/** Where a round's hole is `ms` into the play on `map` at `size` (the floe's share of its full size), or null for none yet. */
export function holeAt(plan: HolePlan | null, map: BonkMap, ms: number, size: number): Hole | null {
  if (!plan || ms < plan.from || size <= 0) return null;
  const t = ms / 1000;
  const [sx, sz] = plan.swings.map((axis) => axis.reduce((v, s) => v + s.a * Math.sin(s.w * t + s.p), 0)) as [number, number];
  const r = HOLE_R * size * Math.min(1, (ms - plan.from) / HOLE_OPEN_MS);
  // Kept on the floe: drawn in toward the middle as far as all of it is on (every map is whole along a line out from its
  // middle), found by halving.
  const d = Math.hypot(sx, sz), out = d > 1e-6 ? (d + HOLE_R) / d : 1;
  let k = 1;
  if (!withinMap(map, sx * out, sz * out)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (withinMap(map, sx * mid * out, sz * mid * out)) lo = mid; else hi = mid; }
    k = lo;
  }
  const x = sx * k, z = sz * k;
  return { x: x * size, z: z * size, r };
}

const withinMap = (map: BonkMap, x: number, z: number): boolean => (map.outline ? inside(map.outline, x, z) : Math.hypot(x, z) <= FLOE_START);

/**
 * What a ball rolls on (core `Ground`): `map` at `size` (the floe's share of its full size, core `floeRadius`), `ms` into
 * the play, with `hole`. Where a rise stands, a hole is under it: none there. Out of the play (`moving` false), the
 * pillars stand still where they are, and push a ball as ones that do.
 */
export function groundOf(map: BonkMap, size: number, ms: number, hole: Hole | null = null, moving = true): Ground {
  if (size <= 0) return { within: () => false, hole: () => false, height: () => 0, slope: () => STILL, pillars: [] };
  const height = (x: number, z: number) => size * heightOn(map, x / size, z / size).h;
  return {
    within: (x, z) => withinMap(map, x / size, z / size),
    hole: (x, z) => hole !== null && Math.hypot(x - hole.x, z - hole.z) < hole.r && height(x, z) < 0.05,
    height,
    slope: (x, z) => { const at = heightOn(map, x / size, z / size); return at.h > 0 ? { x: at.gx, z: at.gz } : STILL; },
    pillars: moving ? pillarsOf(map, size, ms) : pillarsOf(map, size, ms).map((p) => ({ ...p, vx: 0, vz: 0 })),
  };
}

/**
 * Whether a pillar still stands on `map` at `size`: all the way it goes is over the floe. As the floe only shrinks in a
 * round, one that went down stays down, though it moved back in over the floe a moment later. Each map is whole along any
 * line out from its middle, so a pillar stands on it from its full size down to a size of its own (`lowest`), found once.
 */
export const stands = (map: BonkMap, p: Post, size: number): boolean => size > 0 && size >= lowest(map, p);
const lowestOf = new WeakMap<Post, number>();
function lowest(map: BonkMap, p: Post): number {
  let found = lowestOf.get(p);
  if (found !== undefined) return found;
  const way = !p.ms ? [postAt(p, 0)] : Array.from({ length: p.orbit ? 48 : 13 }, (_, i) => postAt(p, (p.orbit ? i / 48 : (i - 6) / 24) * p.ms!));
  const on = (size: number) => way.every((at) => withinMap(map, at.x / size, at.z / size));
  let lo = 0, hi = 1;
  if (!on(1)) found = Infinity;
  else {
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (on(mid)) hi = mid; else lo = mid; }
    found = hi;
  }
  lowestOf.set(p, found);
  return found;
}

/** The pillars standing on `map` at `size`, `ms` into the play (`stands`, `postAt`). */
export const pillarsOf = (map: BonkMap, size: number, ms: number): Pillar[] =>
  map.posts.filter((p) => stands(map, p, size)).map((p) => postAt(p, ms));

/** Whether a ball can stand at a spot on `map` at the start: on it, with room to the edge, flat, and clear of every pillar. */
export function restsOn(map: BonkMap, x: number, z: number): boolean {
  const d = Math.hypot(x, z), out = d > 1e-6 ? (d + BALL_RADIUS * 1.4) / d : 1;
  return withinMap(map, x, z) && withinMap(map, x * out, z * out) && heightOn(map, x, z).h === 0
    && map.posts.every((p) => Math.hypot(x - p.x, z - p.z) >= p.r + BALL_RADIUS + 0.2);
}
