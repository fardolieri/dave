import { describe, expect, it } from 'vitest';
import {
  BOXES, DRIFT_CHARGE, GRACE_MS, GRASS_SPEED, KART_RADIUS, LAPS, MAX_SPEED, OVER_MS, COUNT_MS, TRACK, TRACK_WIDTH,
  advance, boost, boxAt, bump, distance, drive, gridAt, kartAt, kartFrame, locate, onPad, parseFrame, pointAt, spin, standings, PADS,
  type Controls, type Counted, type Kart,
} from '../src/core/skid';
import { firstRound, roundFrame, roundOf, whoOf, type Round } from '../src/core/rounds';

const [A, B, C] = ['A', 'B', 'C'].map((c) => whoOf(c.repeat(87))) as [string, string, string];
const at = (r: Round, ms: number) => r.since + ms;
const DT = 1 / 60;

/** Steers a kart toward a point a little way ahead on the track, full throttle: how a player keeps to the road. */
function autopilot(k: Kart): Controls {
  const ahead = pointAt(locate(k.x, k.z).progress * TRACK.length + 9);
  let diff = Math.atan2(ahead.z - k.z, ahead.x - k.x) - k.h;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return { throttle: 1, steer: Math.max(-1, Math.min(1, diff * 3)), drift: false };
}

describe('Skid, the track (core/skid.ts)', () => {
  it('is a closed loop, as long as a race wants, every point of it on its own middle', () => {
    expect(TRACK.length).toBeGreaterThan(350);
    expect(TRACK.length).toBeLessThan(700);
    for (let i = 0; i < TRACK.points.length; i += 17) {
      const p = TRACK.points[i]!;
      const where = locate(p.x, p.z);
      expect(Math.abs(where.side)).toBeLessThan(0.01);
      expect(where.progress).toBeCloseTo(TRACK.at[i]! / TRACK.length, 3);
    }
    // Off to one side and the other, by the width.
    const p = pointAt(100);
    const right = locate(p.x - Math.sin(p.dir) * 3, p.z + Math.cos(p.dir) * 3);
    expect(right.side).toBeCloseTo(3, 1);
  });

  it('puts the karts two by two behind the line, apart, on the road, facing along it', () => {
    for (let i = 0; i < 8; i++) {
      const g = gridAt(i);
      const where = locate(g.x, g.z);
      expect(Math.abs(where.side)).toBeLessThan(TRACK_WIDTH / 2 - KART_RADIUS);
      expect(where.progress).toBeGreaterThan(0.85);
      for (let j = 0; j < i; j++) { const o = gridAt(j); expect(Math.hypot(o.x - g.x, o.z - g.z)).toBeGreaterThan(2 * KART_RADIUS); }
    }
    expect(Math.abs(Math.cos(gridAt(0).h - pointAt(0).dir))).toBeCloseTo(1, 1);
  });

  it('has its pads and boxes on the road', () => {
    for (let i = 0; i < BOXES.length; i++) { const b = boxAt(i); expect(Math.abs(locate(b.x, b.z).side)).toBeLessThan(TRACK_WIDTH / 2); }
    expect(onPad(PADS[0]! + 0.001, 0)).toBe(true);
    expect(onPad(PADS[0]! + 0.001, TRACK_WIDTH)).toBe(false);
    expect(onPad(0.001, 0)).toBe(false);
  });
});

describe('Skid, a kart (core/skid.ts)', () => {
  it('speeds up to its top speed on the road, slower on the grass, faster boosting', () => {
    let k = kartAt(0);
    for (let i = 0; i < 180; i++) k = drive(k, autopilot(k), DT, i * 16, i * 16);
    expect(k.v).toBeGreaterThan(MAX_SPEED * 0.95);
    expect(k.v).toBeLessThanOrEqual(MAX_SPEED + 0.01);
    // Out on the grass, well off the road.
    let g: Kart = { ...k, x: k.x + 40, z: k.z + 40 };
    for (let i = 0; i < 120; i++) g = drive(g, { throttle: 1, steer: 0, drift: false }, DT, 5000 + i * 16, 0);
    expect(g.v).toBeLessThanOrEqual(GRASS_SPEED + 0.5);
    let b = boost(k, 3000, 1000);
    for (let i = 0; i < 30; i++) b = drive(b, autopilot(b), DT, 3000 + i * 16, 0);
    expect(b.v).toBeGreaterThan(MAX_SPEED + 3);
  });

  it('goes round the track lap by lap, each counted at the line, and finishes after the last', () => {
    let k = kartAt(0);
    let t = 0;
    const laps: number[] = [];
    while (k.finished === null && t < 200_000) {
      const was = k.lap;
      k = drive(k, autopilot(k), DT, t, t);
      if (k.lap !== was) laps.push(k.lap);
      t += DT * 1000;
    }
    expect(laps).toEqual([2, 3, 4]);
    expect(k.lap).toBe(LAPS + 1);
    expect(k.finished).toBeGreaterThan(30_000);
    expect(k.finished).toBeLessThan(120_000);
    // Finished, it rolls to a stop, whatever is pressed.
    const after = drive({ ...k, v: 10 }, { throttle: 1, steer: 1, drift: false }, 1, t, t);
    expect(after.v).toBeLessThan(10);
    expect(after.finished).toBe(k.finished);
  });

  it('counts no lap for crossing the line back and forth, nor for the start', () => {
    let k = kartAt(0);
    // Forward over the line from the grid: still lap 1.
    for (let i = 0; i < 120; i++) k = drive(k, autopilot(k), DT, i * 16, 0);
    expect(locate(k.x, k.z).progress).toBeLessThan(0.2);
    expect(k.lap).toBe(1);
    // Back over it and forward again: still lap 1.
    for (let i = 0; i < 200; i++) k = drive(k, { throttle: -1, steer: 0, drift: false }, DT, 3000 + i * 16, 0);
    for (let i = 0; i < 200; i++) k = drive(k, autopilot(k), DT, 8000 + i * 16, 0);
    expect(k.lap).toBe(1);
  });

  it('boosts after a drift held long enough, and not after a short one', () => {
    let k = kartAt(0);
    for (let i = 0; i < 120; i++) k = drive(k, autopilot(k), DT, i * 16, 0);
    const start = 2000;
    let long = k;
    for (let i = 0; i * DT < DRIFT_CHARGE + 0.2; i++) long = drive(long, { throttle: 1, steer: 1, drift: true }, DT, start + i * 16, 0);
    expect(long.drift).toBe(1);
    long = drive(long, { throttle: 1, steer: 0, drift: false }, DT, start + 1000, 0);
    expect(long.drift).toBe(0);
    expect(long.boostUntil).toBeGreaterThan(start + 1000);
    let short = k;
    for (let i = 0; i < 10; i++) short = drive(short, { throttle: 1, steer: 1, drift: true }, DT, start + i * 16, 0);
    short = drive(short, { throttle: 1, steer: 0, drift: false }, DT, start + 200, 0);
    expect(short.boostUntil).toBe(0);
  });

  it('spins on a slick, losing speed and steering for a moment; bumps out of another kart', () => {
    const k: Kart = { ...kartAt(0), v: 20 };
    const s = spin(k, 1000);
    expect(s.v).toBeCloseTo(7);
    const turned = drive(s, { throttle: 1, steer: 1, drift: false }, 0.1, 1100, 0);
    expect(turned.h).toBeCloseTo(s.h);
    const other = { x: k.x + Math.cos(k.h) * 1.5, z: k.z + Math.sin(k.h) * 1.5 };
    const b = bump(k, other);
    expect(Math.hypot(b.x - other.x, b.z - other.z)).toBeCloseTo(1.5 + (2 * KART_RADIUS - 1.5) / 2);
    expect(b.v).toBeLessThan(k.v);
    expect(bump(k, { x: k.x + 10, z: k.z })).toBe(k);
  });

  it('places the finished first by time, then the furthest round', () => {
    const k = (lap: number, progress: number, finished: number | null, next = 0) => ({ lap, progress, next, finished });
    const order = standings([k(2, 0.5, null, 2), k(4, 0, 61_000), k(3, 0.1, null), k(4, 0, 59_000), k(2, 0.95, null, 0)]);
    expect(order.map((o) => o.finished ?? `${o.lap}:${o.progress}`)).toEqual([59_000, 61_000, '3:0.1', '2:0.5', '2:0.95']);
    // Just over the line from the grid counts as the start, not as most of a lap.
    expect(distance(k(1, 0.97, null, 0))).toBeLessThan(distance(k(1, 0.02, null, 0)));
  });
});

describe('Skid, the races (core/skid.ts)', () => {
  const c = (who: string, n: number, finished: number | null = null, known = n): Counted => ({ who, n, known, finished });

  it('counts down, races until everyone finished, the fastest wins, and races again', () => {
    let r = advance(firstRound(0), 0, [c(B, 0), c(A, 0)]);
    expect(r).toMatchObject({ n: 1, phase: 'count', players: [A, B] });
    r = advance(r, at(r, COUNT_MS), [c(A, 1), c(B, 1)]);
    expect(r.phase).toBe('play');
    expect(advance(r, at(r, 60_000), [c(A, 1, 58_000), c(B, 1)])).toBe(r);
    r = advance(r, at(r, 61_000), [c(A, 1, 58_000), c(B, 1, 60_500)]);
    expect(r).toMatchObject({ phase: 'over', winner: A, scores: { [A]: 58_000, [B]: 60_500 }, wins: { [A]: 1 } });
    r = advance(r, at(r, OVER_MS), [c(A, 1), c(B, 1)]);
    expect(r).toMatchObject({ n: 2, phase: 'count', wins: { [A]: 1 } });
  });

  it('gives the rest a while once the first has finished, then ends without them', () => {
    const r: Round = { ...firstRound(0), n: 4, phase: 'play', players: [A, B, C] };
    const here = [c(A, 4, 70_000), c(B, 4), c(C, 4)];
    expect(advance(r, 70_000 + GRACE_MS - 1, here)).toBe(r);
    expect(advance(r, 70_000 + GRACE_MS, here)).toMatchObject({ phase: 'over', winner: A, scores: { [A]: 70_000 } });
  });

  it('counts a player gone or watching as out, one not yet in the race as in it', () => {
    const r: Round = { ...firstRound(0), n: 4, phase: 'play', players: [A, B] };
    // B has not taken the race yet: A's finish does not end it at once.
    expect(advance(r, 50_000, [c(A, 4, 49_000), c(B, 3)])).toBe(r);
    // B reloaded and watches: A alone finished, and the race is over.
    expect(advance(r, 50_000, [c(A, 4, 49_000), c(B, 0, null, 4)])).toMatchObject({ phase: 'over', winner: A });
  });
});

describe('Skid, on the wire (core/skid.ts)', () => {
  it('reads back a kart and a race with its times, and drops anything off', () => {
    const k: Kart = { ...kartAt(1), v: 12.345, lap: 2, next: 1, progress: 0.123456, finished: null, drift: -1, boostUntil: 5000 };
    const f = kartFrame(k, 3, 3, 4000, [1.5, -2.25, 1_763_700_000_000]);
    const back = parseFrame(JSON.stringify(f));
    expect(back).toEqual({ ...f, v: 12.35, p: 0.1235, f: -1, b: true, sp: false });
    for (const off of [{ lap: 9 }, { next: 4 }, { p: 1.5 }, { d: 2 }, { s: [1, 2] }, { f: -2 }, { x: 'x' }]) expect(parseFrame(JSON.stringify({ ...f, ...off }))).toBeNull();
    const r: Round = { n: 2, phase: 'over', since: 0, players: [A, B], winner: A, wins: { [A]: 1 }, scores: { [A]: 61_234 } };
    const rf = roundFrame(r, 500, 1);
    expect(parseFrame(JSON.stringify(rf))).toEqual(rf);
    expect(roundOf(rf, 1000).scores).toEqual({ [A]: 61_234 });
  });
});
