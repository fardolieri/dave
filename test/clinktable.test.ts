import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIMBS, FELL, RIDING, START_CHIPS, TOP } from '../src/core/clink';
import { AWAY_MS, HEARD_MS, STALE_MS, createTable, rankOf, type Table, type Wire } from '../src/core/clinktable';
import { seeded } from './fun';

// Clink's tables, several at once, over a pretend network: frames take LATENCY_MS, a friend who leaves closes their
// links, the clock is the test's. What the players see when one comes in, leaves, comes back or looks away.

const LATENCY_MS = 30;
const STEP_MS = 16;
// Keys in the order they lead in: the smallest first ('0' before 'A').
const DAN = '0'.repeat(43), ALICE = 'A'.repeat(43), BOB = 'B'.repeat(43), CAROL = 'C'.repeat(43);

/** The wall clock the leader's frames are ordered by (core/rounds.ts, `q`), going as the test's does. */
let wall = 0;
beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000 + wall); });
afterEach(() => { vi.restoreAllMocks(); });

class Net {
  clock = 1000;
  private queue: { at: number; to: string; from: string; data: string }[] = [];
  private seats = new Map<string, { table: Table; listeners: Set<(from: string, data: unknown) => void>; visible: boolean; awake: boolean }>();
  /** Not yet in the call's game with the others: playing alone, no link to anyone. */
  private apart = new Set<string>();

  add(key: string, rand: () => number = () => 0.5, apart = false): Table {
    const listeners = new Set<(from: string, data: unknown) => void>();
    if (apart) this.apart.add(key);
    const linked = (a: string, b: string) => a !== b && !this.apart.has(a) && !this.apart.has(b);
    const wire: Wire = {
      broadcast: (data) => { for (const to of this.seats.keys()) if (linked(key, to)) this.queue.push({ at: this.clock + LATENCY_MS, to, from: key, data }); },
      listen: (f) => { listeners.add(f); return () => listeners.delete(f); },
      connected: () => [...this.seats.keys()].filter((k) => linked(key, k)),
    };
    const table = createTable(key, wire, rand, () => this.clock);
    this.seats.set(key, { table, listeners, visible: true, awake: true });
    return table;
  }
  /** Joins the others: the links open. */
  join(key: string): void { this.apart.delete(key); }
  /** Leaves the game: the table stops, its links close. */
  remove(key: string): void { this.seats.get(key)?.table.close(); this.seats.delete(key); }
  /** A tab in the background: steps, but may not lead. */
  hide(key: string, hidden = true): void { this.seats.get(key)!.visible = !hidden; }
  /** A phone put down: sends nothing, its link still open. */
  sleep(key: string, asleep = true): void { this.seats.get(key)!.awake = !asleep; }
  table(key: string): Table { return this.seats.get(key)!.table; }

  run(ms: number, each?: () => void): void {
    const until = this.clock + ms;
    while (this.clock < until) {
      this.clock += STEP_MS;
      wall = this.clock;
      const due = this.queue.filter((m) => m.at <= this.clock);
      this.queue = this.queue.filter((m) => m.at > this.clock);
      for (const m of due) { const s = this.seats.get(m.to); if (s?.awake) for (const f of s.listeners) f(m.from, m.data); }
      for (const s of this.seats.values()) if (s.awake) s.table.step(this.clock, s.visible);
      each?.();
    }
  }
  /** Runs until `done`, at most `ms`. */
  until(done: () => boolean, ms = 60_000): void {
    const stop = this.clock + ms;
    while (!done() && this.clock < stop) this.run(STEP_MS);
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
  it('ranks who knows the newest round, then the newest climb of it, then who may lead', () => {
    expect(rankOf(3, 0, true)).toBeGreaterThan(rankOf(2, 9, true));
    expect(rankOf(3, 2, false)).toBeGreaterThan(rankOf(3, 1, true));
    expect(rankOf(3, 2, true)).toBeGreaterThan(rankOf(3, 2, false));
  });

  it('plays a match from start to end, two friends agreeing on every climb, the scores and the winner', () => {
    const net = new Net();
    // Alice alone practises; then Bob comes, and the match's first climb is another than practice's first.
    const a = net.add(ALICE, seeded(1));
    net.run(500);
    const practice = a.climbId();
    expect(practice).toContain('practice');
    const b = net.add(BOB, seeded(2));
    const climbs: number[] = [];
    net.until(() => a.round.phase === 'play' && a.climb !== null);
    expect(a.climbId()).not.toBe(practice);
    // Each grabs at the second coin.
    net.until(() => {
      for (const t of [a, b]) if (t.climb && t.climb.h >= 2) t.grab(net.clock);
      if (a.climb && climbs[climbs.length - 1] !== a.climb.c) climbs.push(a.climb.c);
      return a.round.phase === 'over';
    }, 600_000);
    expect(climbs).toEqual(Array.from({ length: CLIMBS }, (_, i) => i + 1));
    net.run(500);
    expect(b.round.phase).toBe('over');
    expect(a.round.scores).toEqual({ [ALICE.slice(0, 11)]: Math.floor(a.seat.chips), [BOB.slice(0, 11)]: Math.floor(b.seat.chips) });
    expect(b.round.winner).toBe(a.round.winner);
    expect(a.round.winner).toBe(a.seat.chips >= b.seat.chips ? ALICE.slice(0, 11) : BOB.slice(0, 11));
  });

  it('keeps the match\'s tower when a friend with the smallest key comes in: nobody\'s stake goes, no climb starts again', () => {
    // Dan practises alone first, up to a climb further on than the match will be at.
    const net = new Net();
    const d = net.add(DAN, () => 0.5, true);
    net.until(() => (d.climb?.c ?? 0) >= 3, 240_000);
    const a = net.add(ALICE);
    net.add(BOB);
    net.until(() => a.round.phase === 'play' && a.climb?.c === 2 && a.seat.at === RIDING, 240_000);
    expect(d.climb!.c).toBeGreaterThan(2);
    const stake = a.seat.stake;
    net.join(DAN);
    let lowest = Infinity;
    net.run(4000, () => { lowest = Math.min(lowest, a.climb?.c ?? Infinity); });
    expect(lowest).toBe(2);
    expect(a.round.phase).toBe('play');
    expect(a.seat).toMatchObject({ c: 2, stake });
    // Dan watches this match, and may lead it now that he knows its tower: from where it is.
    expect(net.table(DAN).watching()).toBe(true);
    expect(net.table(DAN).climb?.c).toBe(2);
  });

  it('gives those on the tower the time to grab when the leader leaves mid-climb, and lands one coin at a time', () => {
    const net = matchOf(ALICE, BOB, CAROL);
    const c = net.table(CAROL);
    net.until(() => (c.climb?.h ?? 0) >= 2);
    expect(c.leader).toBe(ALICE);
    net.remove(ALICE);
    const left = c.climb!.h;
    // The first grab Carol can make once Bob leads: at the height Alice left it at, before the overdue coin comes down.
    let h = left, jumped = false, firstGrabAt: number | null = null;
    net.run(HEARD_MS + 3000, () => {
      const now = c.climb!.h;
      if (now - h > 1) jumped = true;
      h = now;
      if (c.leader === BOB && firstGrabAt === null && c.canGrab(net.clock)) firstGrabAt = now;
    });
    expect(c.leader).toBe(BOB);
    expect(jumped).toBe(false);
    expect(firstGrabAt).toBe(left);
    expect(c.climb!.h).toBeGreaterThan(2);
  });

  it('hands the lead from a tab in the background to one in front, and the coins keep their time', () => {
    const net = matchOf(ALICE, BOB);
    const b = net.table(BOB);
    net.until(() => (b.climb?.h ?? 0) >= 1);
    net.hide(ALICE);
    net.run(500);
    expect(b.leader).toBe(BOB);
    expect(net.table(ALICE).leader).toBe(BOB);
    // The coins go on landing, one at a time, with time to grab between.
    const from = b.climb!.h;
    let jumped = false, h = from;
    net.run(4000, () => { const now = b.climb!.h; if (now - h > 1) jumped = true; h = now; });
    expect(b.climb!.h).toBeGreaterThan(from);
    expect(jumped).toBe(false);
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
    expect(a.round.winner).toBe(ALICE.slice(0, 11));
    expect(AWAY_MS).toBeGreaterThan(HEARD_MS);
  });

  it('shows nothing stale to a tab that comes back: what happened while it was away is not played at once', () => {
    const net = matchOf(ALICE, BOB);
    const b = net.table(BOB);
    b.drain(net.clock);
    // Away 25 s: the tab steps now and then (a background tab's timer), draws and drains nothing.
    net.hide(BOB);
    for (let i = 0; i < 25; i++) { net.sleep(BOB); net.run(960); net.sleep(BOB, false); net.run(STEP_MS); }
    net.hide(BOB, false);
    const shown = b.drain(net.clock);
    expect(shown.every((h) => net.clock - h.at <= STALE_MS)).toBe(true);
    expect(shown.filter((h) => h.kind === 'fell' && h.climb !== b.climbId())).toEqual([]);
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

  it('pays one who rode a tower down nothing back, and one who grabbed what the coins made', () => {
    const net = matchOf(ALICE, BOB);
    const a = net.table(ALICE), b = net.table(BOB);
    net.until(() => (a.climb?.h ?? 0) >= 1);
    a.grab(net.clock);
    expect(a.seat.at).toBeGreaterThanOrEqual(1);
    expect(a.seat.won).toBeGreaterThan(a.seat.stake);
    net.until(() => (b.climb?.fell ?? -1) >= 0 || b.seat.at !== RIDING, 60_000);
    // Never topples (0.5 a roll): Bob rides it to the top.
    expect(b.seat.at).toBe(TOP);
    expect(b.seat.at).not.toBe(FELL);
    expect(START_CHIPS).toBeGreaterThan(0);
  });
});
