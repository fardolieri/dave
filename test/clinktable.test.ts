import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIMBS, FELL, RIDING } from '../src/core/clink';
import { AWAY_MS, HEARD_MS, STALE_MS, createTable, type Table, type Wire } from '../src/core/clinktable';
import { seeded } from './fun';

// Clink's tables, several at once, over a pretend network: frames take LATENCY_MS, a friend who leaves closes their
// links, the clock is the test's. What the players see when one comes in, leaves, comes back or looks away.

const LATENCY_MS = 30;
const STEP_MS = 16;
// Keys in the order they lead in: the smallest first ('0' before 'A').
const DAN = '0'.repeat(43), ALICE = 'A'.repeat(43), BOB = 'B'.repeat(43), CAROL = 'C'.repeat(43);
const who = (key: string) => key.slice(0, 11);

/** The wall clock the leader's frames are ordered by (core/rounds.ts, `q`), going as the test's does. */
let wall = 0;
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000 + wall); });
afterEach(() => { vi.restoreAllMocks(); });

class Net {
  clock = 1000;
  latency = LATENCY_MS;
  private queue: { at: number; to: string; from: string; data: string }[] = [];
  private seats = new Map<string, { table: Table; listeners: Set<(from: string, data: unknown) => void>; awake: boolean; every: number; last: number }>();
  /** Not yet in the call's game with the others: playing alone, no link to anyone. */
  private apart = new Set<string>();
  /** Frames lost on the way: from, to, the frame. */
  lose: (from: string, to: string, data: string) => boolean = () => false;

  add(key: string, rand: () => number = seeded(key.charCodeAt(0)), apart = false): Table {
    const listeners = new Set<(from: string, data: unknown) => void>();
    if (apart) this.apart.add(key);
    const linked = (a: string, b: string) => a !== b && !this.apart.has(a) && !this.apart.has(b);
    const wire: Wire = {
      broadcast: (data) => { for (const to of this.seats.keys()) if (linked(key, to)) this.queue.push({ at: this.clock + this.latency, to, from: key, data }); },
      listen: (f) => { listeners.add(f); return () => listeners.delete(f); },
      connected: () => [...this.seats.keys()].filter((k) => linked(key, k)),
    };
    const table = createTable(key, wire, rand, () => this.clock);
    this.seats.set(key, { table, listeners, awake: true, every: 0, last: this.clock });
    return table;
  }
  /** Joins the others: the links open. */
  join(key: string): void { this.apart.delete(key); }
  /** Leaves the game: the table stops, its links close. */
  remove(key: string): void { this.seats.get(key)?.table.close(); this.seats.delete(key); }
  /** A tab in the background: its timer comes every `ms` (0: in front again). */
  background(key: string, ms: number): void { this.seats.get(key)!.every = ms; }
  /** A phone put down: sends and hears nothing, its link still open. */
  sleep(key: string, asleep = true): void { this.seats.get(key)!.awake = !asleep; }
  table(key: string): Table { return this.seats.get(key)!.table; }

  run(ms: number, each?: () => void): void {
    const until = this.clock + ms;
    while (this.clock < until) {
      this.clock += STEP_MS;
      wall = this.clock;
      const due = this.queue.filter((m) => m.at <= this.clock);
      this.queue = this.queue.filter((m) => m.at > this.clock);
      for (const m of due) { const s = this.seats.get(m.to); if (s?.awake && !this.lose(m.from, m.to, m.data)) for (const f of s.listeners) f(m.from, m.data); }
      for (const s of this.seats.values()) if (s.awake && this.clock - s.last >= s.every) { s.last = this.clock; s.table.step(this.clock); }
      each?.();
    }
  }
  /** Runs until `done`, at most `ms`. */
  until(done: () => boolean, ms = 60_000, each?: () => void): void {
    const stop = this.clock + ms;
    while (!done() && this.clock < stop) this.run(STEP_MS, each);
    expect(done(), 'came about in time').toBe(true);
  }
}

/** A match of these, on its first climb's coins: everyone on the tower. */
function matchOf(...keys: string[]): Net {
  const net = new Net();
  for (const k of keys) net.add(k);
  net.until(() => keys.every((k) => net.table(k).round.phase === 'play' && net.table(k).seat.at === RIDING));
  return net;
}

describe('Clink, tables at once (core/clinktable.ts)', () => {
  it('plays a match from start to end, two friends seeing the same towers and agreeing on the scores and the winner', () => {
    const net = new Net();
    // Alice alone practises; then Bob comes, and the match's first climb is another than practice's first.
    const a = net.add(ALICE);
    net.run(500);
    const practice = a.climbId();
    expect(practice).toContain('wait');
    const b = net.add(BOB);
    net.until(() => a.round.phase === 'play' && a.climb !== null);
    expect(a.climbId()).not.toBe(practice);
    // Each grabs at the second coin; their towers never more than a coin apart (a frame's way), and fall at the same.
    const climbs: number[] = [];
    let apart = 0;
    const falls = new Map<string, number>();
    net.until(() => {
      for (const t of [a, b]) {
        if (t.climb && t.climb.h >= 2) t.grab(net.clock);
        if (t.climb && t.climb.fell >= 0) falls.set(`${t === a ? 'a' : 'b'}${t.climb.c}`, t.climb.h);
      }
      if (a.climb && b.climb && a.climb.c === b.climb.c) apart = Math.max(apart, Math.abs(a.climb.h - b.climb.h));
      if (a.climb && climbs[climbs.length - 1] !== a.climb.c) climbs.push(a.climb.c);
      return a.round.phase === 'over';
    }, 600_000);
    expect(climbs).toEqual(Array.from({ length: CLIMBS }, (_, i) => i + 1));
    expect(apart).toBeLessThanOrEqual(1);
    for (let c = 1; c <= CLIMBS; c++) expect(falls.get(`b${c}`), `climb ${c}`).toBe(falls.get(`a${c}`));
    net.run(500);
    expect(b.round.phase).toBe('over');
    expect(a.round.scores).toEqual({ [who(ALICE)]: Math.floor(a.seat.chips), [who(BOB)]: Math.floor(b.seat.chips) });
    expect(b.round.winner).toBe(a.round.winner);
    expect(a.round.winner).toBe(a.seat.chips >= b.seat.chips ? who(ALICE) : who(BOB));
  });

  it('keeps the match\'s tower when a friend with the smallest key comes in: nobody\'s stake goes, no climb starts again', () => {
    // Dan practises alone first, further on than the match will be.
    const net = new Net();
    const d = net.add(DAN, () => 0.5, true);
    net.until(() => (d.climb?.c ?? 0) >= 3, 240_000);
    const a = net.add(ALICE);
    net.add(BOB);
    net.until(() => a.round.phase === 'play' && a.climb?.c === 2 && a.seat.at === RIDING, 240_000);
    const stake = a.seat.stake;
    net.join(DAN);
    let lowest = Infinity;
    net.run(4000, () => { lowest = Math.min(lowest, a.climb?.c ?? Infinity); });
    expect(lowest).toBe(2);
    expect(a.round.phase).toBe('play');
    expect(a.seat).toMatchObject({ c: 2, stake });
    expect(d.watching()).toBe(true);
    expect(d.climb?.c).toBe(2);
    expect(d.climbId()).toBe(a.climbId());
  });

  it('goes on with the tower when the leader leaves mid-climb: no coin late, none down at once, a grab open throughout', () => {
    const net = matchOf(ALICE, BOB, CAROL);
    const c = net.table(CAROL);
    net.until(() => (c.climb?.h ?? 0) >= 1 && c.climb!.fell < 0);
    expect(c.leader).toBe(ALICE);
    net.remove(ALICE);
    // From now on through the climb: Carol can grab between coins, and they come one at a time.
    let h = c.climb!.h, jumped = false, shut = 0;
    const climbNo = c.climb!.c;
    net.run(HEARD_MS + 2000, () => {
      if (!c.climb || c.climb.c !== climbNo || c.climb.fell >= 0) return;
      if (c.climb.h - h > 1) jumped = true;
      h = c.climb.h;
      if (!c.canGrab(net.clock)) shut++;
    });
    expect(c.leader).toBe(BOB);
    expect(jumped).toBe(false);
    expect(shut).toBe(0);
  });

  it('keeps the tower going for all while the leader is away, and the lead passes on', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    net.until(() => (b.climb?.h ?? 0) >= 1 && b.climb!.fell < 0);
    // Every coin lands from the next on, on both tables.
    const from: [number, number] = [b.climb!.c, b.climb!.h + 1];
    for (const t of [a, b]) t.rig(0.5, net.clock, from);
    net.sleep(ALICE);
    const c = b.climb!.c, h = b.climb!.h;
    net.run(1500);
    expect(b.climb).toMatchObject({ c, fell: -1 });
    expect(b.climb!.h).toBeGreaterThan(h);
    net.run(HEARD_MS);
    expect(b.leader).toBe(BOB);
  });

  it('ends a match on time while the leader\'s tab is in the background, its timer once a second, and starts the next', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    net.until(() => a.climb?.c === CLIMBS - 1, 600_000);
    // Firefox's background timer: a little over a second apart. It leads on, a step a second.
    net.background(ALICE, 1004);
    const n = b.round.n;
    const end = b.climb!.t0 + 600_000;
    net.until(() => b.round.n === n && b.round.phase === 'over', 120_000);
    expect(net.clock).toBeLessThan(end);
    net.until(() => b.round.n === n + 1 && b.round.phase === 'count', 20_000);
    expect(a.round.n).toBeGreaterThanOrEqual(n);
  });

  it('lets nobody who knows less restart a match while all who know it hold back: a reload, a newcomer', () => {
    for (const comes of ['reload', 'newcomer'] as const) {
      const net = matchOf(ALICE, BOB);
      const b = net.table(BOB);
      net.until(() => (b.climb?.c ?? 0) >= 2, 120_000);
      const id = b.climbId(), c = b.climb!.c;
      const seed = id.split(':')[2];
      // Bob's tab long in the background, its timer further apart than the others take to stop hearing him (holding
      // back at every step); Alice reloads, or Dan comes in, knowing round 0.
      net.background(BOB, 3000);
      if (comes === 'reload') { net.remove(ALICE); net.add(ALICE); } else { net.add(DAN); net.background(ALICE, 3000); }
      let lowest = Infinity;
      net.run(6000, () => { if (b.climbId().split(':')[2] === seed) lowest = Math.min(lowest, b.climb?.c ?? Infinity); else lowest = -1; });
      expect(lowest, `${comes}: Bob's match keeps its seed and climbs`).toBeGreaterThanOrEqual(c);
      // Bob back in front: he leads it on, and the one who came follows it.
      net.background(BOB, 0);
      net.run(3000);
      const came = net.table(comes === 'reload' ? ALICE : DAN);
      expect(came.round.n, comes).toBe(b.round.n);
      expect(came.climbId(), comes).toBe(b.climbId());
    }
  });

  it('keeps a friend away a while in the match, link open; ends it once they have left', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE);
    net.sleep(BOB);
    net.run(HEARD_MS * 3);
    expect(a.round.phase).toBe('play');
    expect(a.present(net.clock).map((o) => o.key)).toEqual([BOB]);
    net.remove(BOB);
    net.run(HEARD_MS + 500);
    expect(a.round.phase).toBe('over');
    expect(a.round.winner).toBe(who(ALICE));
    expect(AWAY_MS).toBeGreaterThan(HEARD_MS);
  });

  it('counts a friend away on the last tower by the chips they kept, not the stake that went with it', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    net.until(() => b.climb?.c === CLIMBS && b.seat.at === RIDING && b.climb.fell < 0, 600_000, () => { for (const t of [a, b]) if (t.climb && t.climb.c < CLIMBS && t.climb.h >= 1) t.grab(net.clock); });
    // His frames say he is on the tower, his stake off his chips; then he puts the phone down.
    net.until(() => a.others().get(BOB)?.frame.a === RIDING && a.others().get(BOB)?.frame.c === CLIMBS && b.climb!.fell < 0, 2000);
    const kept = b.seat.chips, stake = b.seat.stake;
    expect(stake).toBeGreaterThan(0);
    net.sleep(BOB);
    net.until(() => a.round.phase === 'over', 60_000);
    expect(a.round.scores![who(BOB)]).toBeGreaterThanOrEqual(Math.floor(kept) - 1);
    expect(a.round.scores![who(BOB)]).toBeLessThan(kept + stake / 2);
  });

  it('is not led back into a match by a friend who missed its end, the smaller key though theirs is', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    // Alice, who leads, puts her phone down on the last tower; Bob takes over and ends the match.
    net.until(() => a.climb?.c === CLIMBS && a.climb.fell < 0, 600_000);
    net.sleep(ALICE);
    net.until(() => b.round.phase === 'over', 60_000);
    const n = b.round.n, wins = { ...b.round.wins }, since = b.round.since;
    // She wakes a few seconds later; Bob's round frames to her are lost a while (his seat frames get through).
    net.run(3000);
    const woke = net.clock;
    net.lose = (from, to, data) => from === BOB && to === ALICE && data.includes('"k":"r"') && net.clock < woke + 1500;
    net.sleep(ALICE, false);
    let replayed = false, redone = false;
    net.run(3000, () => { if (b.round.n === n && b.round.phase === 'play') replayed = true; if (b.round.phase === 'over' && b.round.since !== since) redone = true; });
    expect(replayed).toBe(false);
    expect(redone, "Bob's end of the match stands").toBe(false);
    expect(b.round.wins).toEqual(wins);
    expect(a.round).toMatchObject({ n, phase: 'over', wins });
  });

  it('shows nothing stale to a tab that comes back: what happened while it was away is not played at once', () => {
    const net = matchOf(ALICE, BOB);
    const b = net.table(BOB);
    b.drain(net.clock);
    // Away 25 s: the tab steps now and then (a background tab's timer), draws and drains nothing.
    for (let i = 0; i < 25; i++) { net.sleep(BOB); net.run(960); net.sleep(BOB, false); net.run(STEP_MS); }
    const shown = b.drain(net.clock);
    expect(shown.every((h) => net.clock - h.at <= STALE_MS)).toBe(true);
  });

  it('is not sent back to waiting by a leader who reloads: a round older than mine is not followed', () => {
    // Three, so the match goes on without the one who reloaded (who comes back to watch it).
    const net = matchOf(ALICE, BOB, CAROL);
    const b = net.table(BOB);
    net.until(() => (b.climb?.h ?? 0) >= 1);
    const n = b.round.n, chips = b.seat.chips + b.seat.stake;
    net.remove(ALICE);
    net.add(ALICE);
    net.run(1500);
    expect(b.round).toMatchObject({ n, phase: 'play' });
    expect(b.seat.chips + (b.seat.at === RIDING ? b.seat.stake : 0)).toBeGreaterThanOrEqual(chips);
  });

  it('keeps its towers when the start is put right a little (a late frame, a new leader), rigs and all', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    net.until(() => a.climb !== null && a.climb.fell < 0 && a.climb.h === 0 && b.climb?.h === 0);
    const c = a.climb!.c;
    for (const t of [a, b]) t.rig(0, net.clock, [c, 1]);
    net.until(() => (b.climb?.fell ?? -1) >= 0, 10_000);
    const fell = { h: b.climb!.h, c: b.climb!.c };
    // The next climb rigged to stand; then a frame of Alice's comes to Bob 400 ms late: he puts her start right.
    for (const t of [a, b]) t.rig(0.5, net.clock, [c + 1, 0]);
    const since = b.round.since;
    let shifted = false, unfell = false, back = false;
    const watch = () => {
      if (b.round.since !== since) shifted = true;
      if (b.climb && b.climb.c === fell.c && (b.climb.h !== fell.h || b.climb.fell < 0)) unfell = true;
      if (b.climb && b.climb.c < fell.c) back = true;
    };
    net.latency = 400;
    net.run(600, watch);
    net.latency = LATENCY_MS;
    net.run(600, watch);
    expect(shifted, 'Bob put the start right').toBe(true);
    // The climb that fell stayed as it fell, and no later rig reached back into it.
    expect(unfell).toBe(false);
    expect(back).toBe(false);
  });

  it('takes the stake of one who rode the tower down, and leaves one who got off with what they won', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    // Every coin lands from the next on, on both tables; Alice gets off at the first.
    net.until(() => a.climb !== null && a.climb.fell < 0 && a.climb.h === 0 && b.climb?.h === 0);
    for (const t of [a, b]) t.rig(0.5, net.clock, [a.climb!.c, 0]);
    net.until(() => (a.climb?.h ?? 0) >= 1);
    a.grab(net.clock);
    const won = a.seat.won;
    expect(won).toBeGreaterThan(a.seat.stake);
    // Then the coin after next topples it, the same one on both.
    const topples: [number, number] = [a.climb!.c, a.climb!.h + 1];
    for (const t of [a, b]) t.rig(0, net.clock, topples);
    net.until(() => b.seat.at === FELL, 10_000);
    expect(a.seat).toMatchObject({ won });
    expect(a.seat.at).toBeGreaterThanOrEqual(1);
    // A rig set once it fell leaves it fallen: it is for the coins nobody has seen yet.
    const fell = b.climb!;
    for (const t of [a, b]) t.rig(0.5, net.clock);
    net.run(500);
    if (b.climb!.c === fell.c) expect(b.climb).toMatchObject({ h: fell.h, fell: fell.fell });
  });
});
