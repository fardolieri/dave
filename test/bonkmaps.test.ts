import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, FLOE_START, MAX_PLAYERS, SHRINK_END_MS, floeRadius, MAX_ROLL, PILLAR_H, SUNK_Y, ballAt, ballFrame, firstStage, parseFrame, roll, stageFrame, toward, type Ball, type Ground, type Round } from '../src/core/bonk';
import { HOLE_CHANCE, HOLE_OPEN_MS, HOLE_R, MAPS, ROUNDS_PER_MAP, groundOf, holeAt, holePlan, mapOf, postAt, reachOf, restsOn, roundOnMap, seatOn, stands, type BonkMap } from '../src/core/bonkmaps';

const map = (id: string): BonkMap => MAPS.find((m) => m.id === id)!;
const STILL = { x: 0, z: 0 };
/** A ball rolled on `g` for `s` seconds, steered `dir`, in steps of a 180th of a second, as the app does. */
const run = (b: Ball, g: Ground, s: number, dir = STILL): Ball => { for (let i = 0; i < s * 180; i++) b = roll(b, dir, 1 / 180, g); return b; };

describe('Bonk\'s maps (core/bonkmaps.ts)', () => {
  it('plays five rounds on each map, then the next, round and round, the floe it always was last', () => {
    expect(ROUNDS_PER_MAP).toBe(5);
    expect(mapOf(0)).toBe(MAPS[0]);
    for (let n = 1; n <= 5; n++) expect(mapOf(n)).toBe(MAPS[0]);
    expect(mapOf(6)).toBe(MAPS[1]);
    expect(mapOf(5 * MAPS.length)).toBe(MAPS.at(-1));
    expect(mapOf(5 * MAPS.length + 1)).toBe(MAPS[0]);
    expect([1, 5, 6, 12].map(roundOnMap)).toEqual([1, 5, 1, 2]);
    expect(MAPS.at(-1)).toMatchObject({ id: 'floe', outline: null, rises: [], posts: [] });
    expect(new Set(MAPS.map((m) => m.id)).size).toBe(MAPS.length);
    // A star, a square, a cone, pillars that move.
    expect(MAPS.map((m) => m.id)).toEqual(expect.arrayContaining(['star', 'square', 'volcano', 'ramps']));
    expect(MAPS.some((m) => m.posts.some((p) => p.ms))).toBe(true);
  });

  it('seats every player of every map on flat floe, clear of the pillars and of each other, however many play', () => {
    for (const m of MAPS) {
      for (let count = 1; count <= MAX_PLAYERS; count++) {
        const seats = Array.from({ length: count }, (_, i) => seatOn(m, i, count));
        for (const s of seats) expect(restsOn(m, s.x, s.z), `${m.id}, ${count} players: ${JSON.stringify(s)}`).toBe(true);
        for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) expect(Math.hypot(seats[i]!.x - seats[j]!.x, seats[i]!.z - seats[j]!.z)).toBeGreaterThan(2 * BALL_RADIUS);
      }
      // Between rounds, a ball that fell comes back anywhere round the seat.
      for (let a = 0; a < 360; a++) expect(restsOn(m, m.seat * Math.cos((a * Math.PI) / 180), m.seat * Math.sin((a * Math.PI) / 180)), `${m.id} at ${a}°`).toBe(true);
    }
  });

  it('keeps a ball standing still where it starts, and drops one over the edge, of a star between its points', () => {
    const star = groundOf(map('star'), 1, 0);
    const seat = seatOn(map('star'), 0, 2);
    expect(run(ballAt(seat.x, seat.z), star, 2)).toMatchObject({ x: seat.x, z: seat.z, alive: true });
    // Between two points the edge is near; along a point, far.
    const between = { x: 7 * Math.cos(-Math.PI / 2 + Math.PI / 5), z: 7 * Math.sin(-Math.PI / 2 + Math.PI / 5) };
    expect(star.within(between.x, between.z)).toBe(false);
    expect(star.within(0, -10.5)).toBe(true);
    expect(run({ ...ballAt(0, -6), vx: 0 }, star, 0.1).alive).toBe(true);
    // A square's corners are further out than its sides.
    const square = groundOf(map('square'), 1, 0);
    expect(square.within(7.9, 7.9)).toBe(true);
    expect(square.within(8.1, 0)).toBe(false);
  });

  it('shrinks a map with the floe, its outline and its rises; its pillars stand where they are, until the edge passes under them', () => {
    const m = map('square'), half = groundOf(m, 0.5, 0);
    expect(half.within(3.9, 3.9)).toBe(true);
    expect(half.within(4.1, 0)).toBe(false);
    expect(half.height(0, 0)).toBeCloseTo(0.7);
    expect(half.slope(0.5, 0).x).toBeCloseTo(groundOf(m, 1, 0).slope(1, 0).x);
    // The square's pillars stand out by its corners: over the sea once it is half as big.
    expect(groundOf(m, 1, 0).pillars).toHaveLength(4);
    expect(half.pillars).toHaveLength(0);
    const bumpers = groundOf(map('bumpers'), 0.5, 0);
    expect(bumpers.pillars).toHaveLength(5);
    expect(bumpers.pillars[0]).toMatchObject({ r: 0.7 });
    expect(Math.hypot(bumpers.pillars[0]!.x, bumpers.pillars[0]!.z)).toBeCloseTo(3);
    expect(groundOf(m, 0, 0).within(0, 0)).toBe(false);
  });

  it('has a cone a ball rolls up some way and back down, and one let go on it rolls off', () => {
    const volcano = groundOf(map('volcano'), 1, 0);
    // Rolled at it as hard as it rolls, it gets up, at a crawl; let go of on the way, it gets less far, and rolls back.
    const up = (steer: number) => {
      let b: Ball = { ...ballAt(-5, 0), vx: MAX_ROLL };
      let highest = 0, slowest = MAX_ROLL;
      for (let i = 0; i < 180 * 2; i++) { b = roll(b, { x: steer, z: 0 }, 1 / 180, volcano); highest = Math.max(highest, volcano.height(b.x, b.z)); if (b.x > -3) slowest = Math.min(slowest, Math.hypot(b.vx, b.vz)); }
      return { b, highest, slowest };
    };
    const pushed = up(1), coasted = up(0);
    expect(pushed.highest).toBeGreaterThan(1.5);
    expect(pushed.slowest).toBeLessThan(MAX_ROLL / 2);
    expect(coasted.highest).toBeLessThan(1.3);
    expect(coasted.b.vx).toBeLessThan(0);
    // Let go up there, it rolls down, faster than it rolls by itself.
    let down: Ball = ballAt(-0.5, 0);
    let fastest = 0;
    for (let i = 0; i < 180 * 1.5; i++) { down = roll(down, STILL, 1 / 180, volcano); fastest = Math.max(fastest, -down.vx); }
    expect(down.x).toBeLessThan(-4.4);
    expect(fastest).toBeGreaterThan(MAX_ROLL);
  });

  it('throws a ball rolled fast over a ridge up into the air, and lets one rolled slowly over it roll on down', () => {
    const ramps = groundOf(map('ramps'), 1, 0);
    // The ridge ahead of the camera, lying along x at z = -2.6: crossed toward the middle.
    const over = (speed: number) => {
      let b: Ball = { ...ballAt(0, -5.2), vz: speed };
      let flew = 0;
      for (let i = 0; i < 180 * 1.2; i++) { b = roll(b, STILL, 1 / 180, ramps); flew = Math.max(flew, b.y); }
      return { b, flew };
    };
    const fast = over(15);
    expect(fast.flew).toBeGreaterThan(0.3);
    expect(fast.b).toMatchObject({ alive: true, y: 0 });
    expect(over(4).flew).toBe(0);
  });

  it('bounces a ball off a pillar it rolls into, and a moving pillar shoves one standing in its way', () => {
    const square = groundOf(map('square'), 1, 0);
    const post = square.pillars[0]!;
    let b: Ball = { ...ballAt(post.x - 3, post.z), vx: 6 };
    b = run(b, square, 0.4);
    expect(b.vx).toBeLessThan(-3);
    expect(Math.hypot(b.x - post.x, b.z - post.z)).toBeGreaterThanOrEqual(post.r + BALL_RADIUS - 1e-9);
    // Over its top, a ball flies past it.
    const high = roll({ ...ballAt(post.x - post.r - BALL_RADIUS - 0.05, post.z), vx: 6, y: PILLAR_H + 1, vy: 0.1 }, STILL, 1 / 60, square);
    expect(high.vx).toBeGreaterThan(5);

    // The carousel's pillars go round: one in its way is shoved along.
    const carousel = map('carousel');
    const at = postAt(carousel.posts[0]!, 0), ahead = postAt(carousel.posts[0]!, 1000);
    expect(Math.hypot(at.vx, at.vz)).toBeCloseTo((2 * Math.PI * 3) / 10);
    expect(Math.hypot(ahead.x, ahead.z)).toBeCloseTo(3);
    let standing = ballAt((at.x + ahead.x) / 2 * 1.02, (at.z + ahead.z) / 2 * 1.02);
    let fastest = 0;
    for (let ms = 0; ms < 1500; ms += 1000 / 180) { standing = roll(standing, STILL, 1 / 180, groundOf(carousel, 1, ms)); fastest = Math.max(fastest, Math.hypot(standing.vx, standing.vz)); }
    expect(fastest).toBeGreaterThan(Math.hypot(at.vx, at.vz));
    // Out of the play they stand still: one rolled into slowly rolls back as slowly.
    const triangle = map('triangle'), corner = postAt(triangle.posts[0]!, 0);
    let slow: Ball = { ...ballAt(corner.x, corner.z - corner.r - BALL_RADIUS - 0.05), vz: 0.3 };
    slow = run(slow, groundOf(triangle, 1, 0, null, false), 0.5);
    expect(slow.alive).toBe(true);
    expect(Math.hypot(slow.vx, slow.vz)).toBeLessThan(0.3);
  });

  it('opens a hole in some rounds, the same on every app, slowly, and lets it wander only over the floe', () => {
    const players = ['aaaaaaaaaaa', 'bbbbbbbbbbb'];
    const plans = Array.from({ length: 400 }, (_, n) => holePlan(map('floe'), n + 1, players));
    const share = plans.filter(Boolean).length / plans.length;
    expect(share).toBeGreaterThan(HOLE_CHANCE - 0.1);
    expect(share).toBeLessThan(HOLE_CHANCE + 0.1);
    expect(holePlan(map('floe'), 7, players)).toEqual(holePlan(map('floe'), 7, [...players]));
    // On a holey map, every round, early.
    for (let n = 1; n < 50; n++) expect(holePlan(map('sinkhole'), n, players)!.from).toBeLessThan(5000);

    for (const m of MAPS) {
      for (let n = 1; n < 40; n++) {
        const plan = holePlan(m, n, players);
        if (!plan) continue;
        expect(holeAt(plan, m, plan.from - 1, 1)).toBeNull();
        expect(holeAt(plan, m, plan.from + HOLE_OPEN_MS / 2, 1)!.r).toBeCloseTo(HOLE_R / 2);
        let last = holeAt(plan, m, plan.from, 1)!, lastSize = 1;
        for (let ms = plan.from; ms < 65_000; ms += 100) {
          const size = ms < 30_000 ? 1 : 0.5;
          const h = holeAt(plan, m, ms, size)!;
          // As wide as the floe is, shrunk with it: never the whole of it.
          expect(h.r).toBeLessThanOrEqual(HOLE_R * size + 1e-9);
          // Its middle always on the floe, and it goes slowly: a ball outruns it.
          expect(groundOf(m, size, ms).within(h.x, h.z), `${m.id} round ${n} at ${ms} ms`).toBe(true);
          if (size === lastSize) expect(Math.hypot(h.x - last.x, h.z - last.z) / 0.1).toBeLessThan(MAX_ROLL / 2);
          last = h; lastSize = size;
        }
      }
    }
  });

  it('drops a ball that rolls over the hole through it, but not one up on a rise over it, nor one flying over it', () => {
    const floe = groundOf(map('floe'), 1, 0, { x: 3, z: 0, r: HOLE_R });
    let b: Ball = { ...ballAt(0, 0), vx: 5 };
    b = run(b, floe, 0.6);
    expect(b.alive).toBe(false);
    expect(Math.hypot(b.x - 3, b.z)).toBeLessThan(HOLE_R);
    expect(b.x).toBeLessThan(3 - HOLE_R + 0.2);
    b = run(b, floe, 2);
    expect(b.y).toBe(SUNK_Y);
    // Flying over it, it lands beyond.
    const short = groundOf(map('floe'), 1, 0, { x: 2, z: 0, r: HOLE_R });
    let up: Ball = { ...ballAt(0, 0), vx: 10, vy: 8, y: 0.01 };
    up = run(up, short, 1);
    expect(up.alive).toBe(true);
    expect(up.x).toBeGreaterThan(2 + HOLE_R);
    // Under a cone, a hole is no hole.
    const volcano = groundOf(map('volcano'), 1, 0, { x: 0, z: 0, r: HOLE_R });
    expect(volcano.hole(0.5, 0)).toBe(false);
    expect(groundOf(map('volcano'), 1, 0, { x: 5, z: 0, r: HOLE_R }).hole(5.5, 0)).toBe(true);
  });

  it('takes a pillar down once the floe\'s edge comes to where it goes, for the rest of the round, never back up under a ball', () => {
    for (const m of MAPS) {
      const was = m.posts.map(() => true);
      for (let ms = 0; ms <= SHRINK_END_MS; ms += 50) {
        const size = floeRadius('play', ms) / FLOE_START, ground = groundOf(m, size, ms), standing = ground.pillars;
        m.posts.forEach((p, i) => {
          const now = stands(m, p, size);
          expect(now && !was[i], `${m.id}'s pillar ${i} back up at ${ms} ms`).toBe(false);
          was[i] = now;
          // Every one standing is over the floe, all the way it goes.
          if (now) expect(ground.within(postAt(p, ms).x, postAt(p, ms).z)).toBe(true);
        });
        expect(standing).toHaveLength(was.filter(Boolean).length);
      }
    }
  });

  it('lets a ball get through to the middle of every map, where a mystery ball falls, from most ways round, however small the floe', () => {
    for (const m of MAPS) {
      // On a cone, a mystery ball rolls down to its foot.
      const middle = m.rises.find((r) => r.kind === 'cone' && r.x === 0 && r.z === 0), cone = middle?.kind === 'cone' ? middle.r : 0;
      for (const size of [1, 0.8, 0.6, 0.45]) {
        let got = 0;
        for (let i = 0; i < 12; i++) {
          const seat = seatOn(m, i, 12);
          let b = ballAt(seat.x * size, seat.z * size), near = Infinity;
          for (let ms = 20_000; ms < 28_000; ms += 1000 / 60) { b = roll(b, toward(b, STILL), 1 / 60, groundOf(m, size, ms)); near = Math.min(near, Math.hypot(b.x, b.z)); }
          if (near < 2 * BALL_RADIUS + cone * size) got++;
        }
        expect(got, `${m.id} at ${size}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('keeps the camera\'s reach for every map: as far out as its furthest corner', () => {
    expect(reachOf(map('floe'))).toBe(FLOE_START);
    expect(reachOf(map('square'))).toBeCloseTo(8 * Math.SQRT2);
    for (const m of MAPS) expect(reachOf(m)).toBeLessThanOrEqual(FLOE_START * 1.35);
  });

  it('says in a ball\'s frame that its app plays the maps, and reads one from an app from before them as such', () => {
    const f = ballFrame(ballAt(1, 2), 1, 1, false);
    expect(f.m).toBe(1);
    expect(parseFrame(JSON.stringify(f))).toEqual(f);
    const { m: _, ...old } = f;
    expect(parseFrame(JSON.stringify(old))).toEqual(old);
    expect(parseFrame(JSON.stringify({ ...old, m: 2 }))).toEqual(old);
    // The leader says whether the round is played on the maps; a leader from before them says nothing, for the floe.
    const r: Round = { n: 3, phase: 'count', since: 0, players: [], winner: null, wins: {} };
    expect(parseFrame(JSON.stringify(stageFrame(r, firstStage(), 10, 1)))).toMatchObject({ mp: 1 });
    expect(parseFrame(JSON.stringify(stageFrame(r, firstStage(), 10, 1, false)))).not.toHaveProperty('mp');
  });

  it('rolls a ball on the floe it always was as before', () => {
    const plain = groundOf(map('floe'), 1, 0);
    let a: Ball = { ...ballAt(0, 0), vx: 3 }, b: Ball = a;
    for (let i = 0; i < 300; i++) { a = roll(a, { x: 0.6, z: 0.8 }, 1 / 60, plain); b = roll(b, { x: 0.6, z: 0.8 }, 1 / 60, FLOE_START); }
    expect(a).toEqual(b);
  });
});
