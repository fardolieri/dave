import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HISTORY_BUDGET_BYTES, KEPT_FILE_MAX, ROW_OVERHEAD_BYTES, keptKind, WRITES_PER_DAY, SYNCS_PER_DAY, SYNCS_PER_WRITE, SYNC_FRAME_BYTES, SYNC_ROWS_PER_DAY, SYNC_OVERLAP_MS, FROM_JOIN, HISTORY_KEEP_MS, PRUNE_AT_MS, nextPrune, entryBytes, formatHistoryUsage, historyFrames, parseHistoryUsage, syncSince } from '../src/core/kept';
import { insertByAt, mergeByAt } from '../src/core/chatlog';
import { exportPublicKey, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { onMessage, type SocketState } from '../src/core/room';
import type { KeptEntry, ServerMessage } from '../src/core/protocol';
import { newBucket } from '../src/core/ratelimit';
import type { Store } from '../src/worker/store';
import { forgetHistoryUsage } from '../src/worker/historyusage';
import { authFrame, nameOf, openRoomSocket, type Challenge } from './harness';

// The server's history (ADR 0009): one Store keeps every room's sealed texts and file announcements in one window, and a
// browser asks after every welcome for what it missed.

/** An hour ago: inside the window (HISTORY_KEEP_MS), whenever the tests run. */
const T0 = Date.now() - 3600_000;
const entry = (n: number, over: Partial<KeptEntry> = {}): KeptEntry => ({
  t: 'sealed', from: { publicKey: `pk${n % 3}`, fingerprint: 'abc234', profile: 'cHJvZmlsZQ' }, sealed: 'c2VhbGVk'.repeat(40), at: T0 + n, id: `id${n}`, ...over,
});
/** A Store of its own per test: the window is the object's, and tests must not see each other's entries. */
const store = (name: string) => env.STORE.get(env.STORE.idFromName(name));

describe('the Store', () => {
  it('keeps entries per room, once per writer and id, and gives the newest after a time, oldest first', async () => {
    await runInDurableObject(store('keeps'), (s: Store) => {
      for (let n = 1; n <= 6; n++) s.keep('roomA', entry(n));
      s.keep('roomB', entry(7));
      // The writer's app sent text 2 again after a lost socket: the Room broadcast it again, with a later time.
      s.keep('roomA', entry(2, { at: T0 + 100 }));
      expect(s.since('roomA', 0, 500)!.map((e) => e.id)).toEqual(['id1', 'id2', 'id3', 'id4', 'id5', 'id6']);
      expect(s.since('roomA', T0 + 3, 500)!.map((e) => e.id), 'after a time only').toEqual(['id4', 'id5', 'id6']);
      expect(s.since('roomA', 0, 2)!.map((e) => e.id), 'the newest of them').toEqual(['id5', 'id6']);
      expect(s.since('roomB', 0, 500)).toEqual([entry(7)]);
      expect(s.since('roomC', 0, 500)).toEqual([]);
      expect(s.usage(5)).toMatchObject({ bytes: 7 * entryBytes(JSON.stringify(entry(1))), budget: HISTORY_BUDGET_BYTES, entries: 7, oldest: entry(1).at, asOf: 5 });
    });
  });

  it('keeps the pieces of a file in the same window as the texts, gives them back one by one, and never in a sync', async () => {
    await runInDurableObject(store('pieces'), (s: Store) => {
      const piece = (fill: number, size = 1000) => new Uint8Array(size).fill(fill);
      expect(s.keepPiece('roomA', 'pkA', 'tagA:0', piece(1), T0 + 1)).toBe(true);
      s.keep('roomA', entry(1));
      expect(s.keepPiece('roomA', 'pkA', 'tagA:1', piece(2), T0 + 2)).toBe(true);
      expect(s.keepPiece('roomA', 'pkA', 'tagA:1', piece(9), T0 + 3), 'sent again after a lost socket: kept once').toBe(true);
      expect(s.piece('roomA', 'tagA:1')).toEqual(piece(2));
      expect(s.piece('roomA', 'tagA:2'), 'not kept').toBeNull();
      expect(s.piece('roomB', 'tagA:0'), "another room's").toBeNull();
      expect(s.since('roomA', 0, 500)!.map((e) => e.id), 'a sync brings texts and announcements only').toEqual(['id1']);
      expect(s.usage().entries).toBe(3);
      expect(s.usage().bytes).toBe(2 * (1000 + ROW_OVERHEAD_BYTES) + entryBytes(JSON.stringify(entry(1))));
    });
  });

  it('keeps the same file sent by two friends as two copies, and gives either', async () => {
    await runInDurableObject(store('copies'), (s: Store) => {
      expect(s.keepPiece('roomA', 'pkA', 'tagA:0', new Uint8Array(10).fill(1), T0 + 1)).toBe(true);
      expect(s.keepPiece('roomA', 'pkB', 'tagA:0', new Uint8Array(10).fill(2), T0 + 2)).toBe(true);
      expect(s.usage().entries).toBe(2);
      expect(s.piece('roomA', 'tagA:0')).not.toBeNull();
      expect(s.forget('roomA', 'pkA', T0 + 10)).toBe(true);
      expect(s.piece('roomA', 'tagA:0'), "the other friend's copy stays").toEqual(new Uint8Array(10).fill(2));
    });
  });

  it('forgets what one friend wrote in one room up to a time, texts, announcements and pieces, and nothing else', async () => {
    await runInDurableObject(store('forget'), (s: Store) => {
      const mine = (n: number, at: number) => entry(n, { at: T0 + at, from: { ...entry(n).from, publicKey: 'pkMe' } });
      s.keep('roomA', mine(1, 10));
      s.keep('roomA', entry(2, { at: T0 + 11 }));
      s.keep('roomA', { ...mine(3, 12), t: 'file' });
      s.keepPiece('roomA', 'pkMe', 'tagA:0', new Uint8Array(100), T0 + 13);
      s.keep('roomB', mine(4, 14));
      s.keep('roomA', mine(5, 30));
      const before = s.usage();
      expect(s.forget('roomA', 'pkMe', T0 + 20)).toBe(true);
      expect(s.since('roomA', 0, 500)!.map((e) => e.id), "a friend's text, and mine after the time, stay").toEqual(['id2', 'id5']);
      expect(s.piece('roomA', 'tagA:0')).toBeNull();
      expect(s.since('roomB', 0, 500)!.map((e) => e.id), 'another room is not this one').toEqual(['id4']);
      expect(s.usage().entries).toBe(before.entries - 3);
      expect(s.usage().bytes).toBe(before.bytes - entryBytes(JSON.stringify(mine(1, 10))) - entryBytes(JSON.stringify({ ...mine(3, 12), t: 'file' })) - (100 + ROW_OVERHEAD_BYTES));
      expect(s.forget('roomA', 'pkMe', T0 + 20), 'nothing left to forget is done').toBe(true);
    });
  });

  it('a forget past what the day can write goes as far as the share goes, and on from there when asked again', async () => {
    await runInDurableObject(store('forget-share'), (s: Store, state) => {
      const day = Date.now();
      for (let n = 1; n <= 30; n++) s.keep('roomA', entry(n, { from: { ...entry(n).from, publicKey: 'pkMe' } }), HISTORY_BUDGET_BYTES, day);
      // Room left today for 10 more drops, not 30.
      state.storage.sql.exec('UPDATE totals SET kept = ?', WRITES_PER_DAY - 1 - 10 * 4);
      expect(s.forget('roomA', 'pkMe', T0 + 100, day)).toBe(false);
      expect(s.since('roomA', 0, 500, day)!.length).toBe(20);
      state.storage.sql.exec('UPDATE totals SET kept = ?', WRITES_PER_DAY - 1);
      expect(s.forget('roomA', 'pkMe', T0 + 100, day), 'the share is used up').toBe(false);
      expect(s.since('roomA', 0, 500, day)!.length).toBe(20);
      expect(s.forget('roomA', 'pkMe', T0 + 100, day + 24 * 3600_000), 'the day after').toBe(true);
      expect(s.since('roomA', 0, 500, day + 24 * 3600_000)).toEqual([]);
    });
  });

  it('gives nothing older than four weeks, and drops it once a day within what is left of the day\'s writes', async () => {
    await runInDurableObject(store('keep'), (s: Store, state) => {
      const now = Date.now();
      const old = (n: number) => entry(n, { at: now - HISTORY_KEEP_MS - 1000 + n });
      for (let n = 1; n <= 5; n++) s.keep('roomA', old(n), HISTORY_BUDGET_BYTES, now);
      s.keepPiece('roomA', 'pkA', 'tagA:0', new Uint8Array(10), now - HISTORY_KEEP_MS - 1, HISTORY_BUDGET_BYTES, now);
      s.keep('roomA', entry(6, { at: now - 1000 }), HISTORY_BUDGET_BYTES, now);
      // Not dropped yet, but not given either.
      expect(s.since('roomA', 0, 500, now)!.map((e) => e.id)).toEqual(['id6']);
      expect(s.piece('roomA', 'tagA:0', now)).toBeNull();
      expect(s.usage(now).entries).toBe(7);
      // Room for two drops today: the two oldest go, the rest the next day.
      state.storage.sql.exec('UPDATE totals SET kept = ?', WRITES_PER_DAY - 1 - 2 * 4);
      expect(s.prune(now)).toBe(2);
      expect(s.usage(now).entries).toBe(5);
      const tomorrow = now + 24 * 3600_000;
      expect(s.prune(tomorrow)).toBe(4);
      expect(s.usage(tomorrow)).toMatchObject({ entries: 1, bytes: entryBytes(JSON.stringify(entry(6, { at: now - 1000 }))) });
      expect(s.prune(tomorrow), 'nothing left to drop').toBe(0);
    });
  });

  it('prunes next at 23:45 UTC, today\'s or tomorrow\'s', () => {
    const day = Date.UTC(2026, 10, 7);
    expect(nextPrune(day + 3600_000)).toBe(day + PRUNE_AT_MS);
    expect(nextPrune(day + PRUNE_AT_MS)).toBe(day + 24 * 3600_000 + PRUNE_AT_MS);
    expect(nextPrune(day + PRUNE_AT_MS + 1)).toBe(day + 24 * 3600_000 + PRUNE_AT_MS);
    expect(new Date(nextPrune(day)).toISOString()).toBe('2026-11-07T23:45:00.000Z');
  });

  it('a piece kept into a full window drops as many texts as it takes, and counts what that writes', async () => {
    await runInDurableObject(store('tail'), (s: Store, state) => {
      // Texts all of one size: ids of one length.
      const text = (n: number) => entry(n, { id: `id${String(n).padStart(3, '0')}` });
      const size = entryBytes(JSON.stringify(text(1)));
      const budget = size * 50;
      for (let n = 1; n <= 50; n++) s.keep('roomA', text(n), budget);
      const written = () => state.storage.sql.exec<{ kept: number }>('SELECT kept FROM totals').one().kept;
      const before = written();
      // One piece the size of ten texts: the ten oldest go, and what that wrote counts against the day.
      expect(s.keepPiece('roomA', 'pkA', 'tagA:0', new Uint8Array(size * 10 - ROW_OVERHEAD_BYTES), T0 + 1, budget)).toBe(true);
      expect(s.since('roomA', 0, 500)!.map((e) => e.id)).toEqual(Array.from({ length: 40 }, (_, i) => text(i + 11).id));
      expect(written() - before, 'the texts dropped count against the day too, as SQLite counts rows written').toBeGreaterThanOrEqual(10 + 1);
      expect(s.usage().bytes).toBe(budget);
      // The window keeps its order: the piece goes before texts kept after it.
      for (let n = 51; n <= 90; n++) s.keep('roomA', text(n), budget);
      expect(s.piece('roomA', 'tagA:0'), 'the texts before it go first').not.toBeNull();
      for (let n = 91; n <= 100; n++) s.keep('roomA', text(n), budget);
      expect(s.piece('roomA', 'tagA:0')).toBeNull();
    });
  });

  it('a fetch that finds nothing writes nothing, and counts what it read against the day\'s share', async () => {
    await runInDurableObject(store('misses'), (s: Store, state) => {
      const day = Date.UTC(2026, 10, 5, 10);
      s.keepPiece('roomA', 'pkA', 'tagA:0', new Uint8Array(10), day, HISTORY_BUDGET_BYTES, day);
      const totals = () => state.storage.sql.exec<{ kept: number; read: number }>('SELECT kept, read FROM totals').one();
      const before = totals();
      for (let i = 0; i < 5; i++) expect(s.piece('roomA', `nothing:${i}`, day)).toBeNull();
      expect(totals(), 'no write for a miss').toEqual(before);
      // Misses that read the day's share away: then nothing is given, not even what is kept, nor a sync.
      (s as unknown as { pending: { day: string; syncs: number; read: number } }).pending = { day: '2026-11-05', syncs: 0, read: SYNC_ROWS_PER_DAY };
      expect(s.piece('roomA', 'tagA:0', day)).toBeNull();
      expect(s.since('roomA', 0, 500, day)).toBeNull();
      expect(s.piece('roomA', 'tagA:0', day + 24 * 3600_000), 'the day after').toEqual(new Uint8Array(10));
    });
  });

  it('keeps no more than its daily share of the free plan\'s rows, and starts again the next day (UTC)', async () => {
    await runInDurableObject(store('share'), (s: Store, state) => {
      const day = Date.UTC(2026, 10, 4, 10);
      state.storage.sql.exec('UPDATE totals SET day = ?, kept = ?', '2026-11-04', WRITES_PER_DAY - 1);
      expect(s.keep('roomA', entry(1), HISTORY_BUDGET_BYTES, day)).toBe(true);
      expect(s.keep('roomA', entry(2), HISTORY_BUDGET_BYTES, day), 'the share used up').toBe(false);
      expect(s.keep('roomA', entry(1), HISTORY_BUDGET_BYTES, day), 'one kept already, the share used up: kept').toBe(true);
      expect(s.since('roomA', 0, 500, day)!.map((e) => e.id)).toEqual(['id1']);
      const next = day + 24 * 3600_000;
      expect(s.keep('roomA', entry(2), HISTORY_BUDGET_BYTES, next), 'a new day').toBe(true);
      state.storage.sql.exec('UPDATE totals SET read = ?', SYNC_ROWS_PER_DAY);
      expect(s.since('roomA', 0, 500, next), 'rows read used up: not known, which is not none').toBeNull();
      state.storage.sql.exec('UPDATE totals SET read = 0, syncs = ?', SYNCS_PER_DAY);
      expect(s.since('roomA', 0, 500, next), 'syncs used up').toBeNull();
      state.storage.sql.exec('UPDATE totals SET syncs = ?', SYNCS_PER_DAY - 1);
      expect(s.since('roomA', 0, 500, next)!.map((e) => e.id), 'the last sync of the day').toEqual(['id1', 'id2']);
      expect(s.since('roomA', 0, 500, next)).toBeNull();
      expect(s.since('roomA', 0, 500, next + 24 * 3600_000)!.map((e) => e.id), 'the day after').toEqual(['id1', 'id2']);
    });
  });

  it('counts syncs in memory and writes them with the totals every few, or with a keep; About sees them all', async () => {
    await runInDurableObject(store('pending'), (s: Store, state) => {
      const day = Date.UTC(2026, 10, 5, 10);
      s.keep('roomA', entry(1), HISTORY_BUDGET_BYTES, day);
      const row = () => state.storage.sql.exec<{ kept: number; syncs: number; read: number }>('SELECT kept, syncs, read FROM totals').one();
      const before = row();
      for (let i = 1; i < SYNCS_PER_WRITE; i++) s.since('roomA', 0, 500, day);
      expect(row(), 'nothing written yet').toEqual(before);
      expect(s.usage(day).today, 'but counted').toMatchObject({ day: '2026-11-05', syncs: SYNCS_PER_WRITE - 1 });
      s.since('roomA', 0, 500, day);
      expect(row(), 'the tenth writes them, and counts its own write').toMatchObject({ kept: before.kept + 1, syncs: SYNCS_PER_WRITE });
      expect(row().read).toBeGreaterThan(before.read);
      s.since('roomA', 0, 500, day);
      s.keep('roomA', entry(2), HISTORY_BUDGET_BYTES, day);
      expect(row().syncs, 'a keep writes what is pending').toBe(SYNCS_PER_WRITE + 1);
      expect(s.usage(day)).toMatchObject({ today: { day: '2026-11-05', syncs: SYNCS_PER_WRITE + 1 }, shares: { syncs: SYNCS_PER_DAY, written: WRITES_PER_DAY, read: SYNC_ROWS_PER_DAY } });
      s.since('roomA', 0, 500, day);
      expect(s.usage(day + 24 * 3600_000).today, 'a new day starts from none, what was pending of the last one dropped').toEqual({ day: '2026-11-06', syncs: 0, written: 0, read: 0 });
      // The share of writes used up: syncs are still written every few, or an eviction would forget them, and their share.
      state.storage.sql.exec('UPDATE totals SET kept = ?', WRITES_PER_DAY);
      const used = row();
      for (let i = 0; i < SYNCS_PER_WRITE; i++) s.since('roomA', 0, 500, day);
      expect(row()).toMatchObject({ kept: WRITES_PER_DAY + 1, syncs: used.syncs + SYNCS_PER_WRITE });
    });
  });

  it('drops the oldest entries of all rooms once the window is full, and counts what is left', async () => {
    await runInDurableObject(store('window'), (s: Store) => {
      const size = entryBytes(JSON.stringify(entry(10)));
      const budget = size * 5;
      for (let n = 10; n <= 14; n++) s.keep(n % 2 ? 'roomA' : 'roomB', entry(n), budget);
      expect(s.usage().entries).toBe(5);
      s.keep('roomA', entry(15), budget); // one too many: the oldest of all goes, roomB's
      expect(s.since('roomB', 0, 500)!.map((e) => e.id)).toEqual(['id12', 'id14']);
      expect(s.since('roomA', 0, 500)!.map((e) => e.id)).toEqual(['id11', 'id13', 'id15']);
      expect(s.usage()).toMatchObject({ bytes: size * 5, entries: 5, oldest: entry(11).at });
      s.keep('roomB', entry(16, { sealed: 'c2VhbGVk'.repeat(120) }), budget); // a longer one makes room for itself
      expect(s.usage().bytes).toBeLessThanOrEqual(budget);
      expect(s.since('roomA', 0, 500)!.map((e) => e.id)).toEqual(['id13', 'id15']);
    });
  });

  it('counts an entry as at least what it costs on disk, so a full window fits the budget there too', async () => {
    await runInDurableObject(store('disk'), (s: Store, state) => {
      const before = state.storage.sql.databaseSize;
      for (let n = 0; n < 2000; n++) s.keep(`room${n % 5}`, { ...entry(n), from: { publicKey: toBase64Url(new Uint8Array(65).fill(n % 7)), fingerprint: 'abc234', profile: 'cHJvZmlsZQ' }, id: n.toString(16).padStart(24, '0') });
      expect(s.usage().bytes).toBeGreaterThanOrEqual(state.storage.sql.databaseSize - before);
    });
  });
});

describe('a sync', () => {
  it('keeps files up to KEPT_FILE_MAX, not one that goes in large pieces', () => {
    expect(keptKind({ size: 0 })).toBe(true);
    expect(keptKind({ size: KEPT_FILE_MAX })).toBe(true);
    expect(keptKind({ size: KEPT_FILE_MAX + 1 })).toBe(false);
    expect(keptKind({ size: 1000, piece: 1024 * 1024 })).toBe(false);
  });

  it('splits what it brings into frames of about SYNC_FRAME_BYTES, the last one marked with up to when, one empty frame for nothing', () => {
    expect(historyFrames([], 77)).toEqual([{ t: 'history', entries: [], last: true, upTo: 77 }]);
    expect(historyFrames(null, 77), 'not known: no up to when').toEqual([{ t: 'history', entries: [], last: true, unavailable: true }]);
    const big = Array.from({ length: 300 }, (_, n) => entry(n, { sealed: 'A'.repeat(2000) }));
    const frames = historyFrames(big, 77);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.flatMap((f) => f.entries)).toEqual(big);
    for (const f of frames) expect(JSON.stringify(f).length).toBeLessThan(SYNC_FRAME_BYTES + 3000);
    expect(frames.map((f) => f.last ?? false)).toEqual([...frames.slice(1).map(() => false), true]);
    expect(frames.map((f) => f.upTo)).toEqual([...frames.slice(1).map(() => undefined), 77]);
  });

  it('asks from where it last had everything less the overlap, from where its history starts at the earliest, from the start for nothing', () => {
    expect(syncSince(null, null)).toBe(0);
    expect(syncSince(1_000_000_000, null)).toBe(1_000_000_000 - SYNC_OVERLAP_MS);
    expect(syncSince(1_000_000_000, 1_000_000_500)).toBe(1_000_000_500);
    expect(syncSince(null, 7)).toBe(7);
    // Joined and not synced yet: past everything, so the first sync brings nothing and says where the Room's clock is.
    expect(syncSince(null, FROM_JOIN)).toBe(FROM_JOIN);
    expect(syncSince(1_000_000_000, FROM_JOIN)).toBe(FROM_JOIN);
  });

  it('places a text the server brought where its time says, a live one last', () => {
    const at = (...xs: number[]) => xs.map((n) => ({ at: n }));
    expect(insertByAt(at(1, 3, 5), { at: 4 })).toEqual(at(1, 3, 4, 5));
    expect(insertByAt(at(1, 3), { at: 9 })).toEqual(at(1, 3, 9));
    expect(insertByAt(at(2, 3), { at: 1 })).toEqual(at(1, 2, 3));
    const same = insertByAt([{ at: 3, n: 'first' }], { at: 3, n: 'second' });
    expect(same.map((x) => x.n), 'after one of the same time').toEqual(['first', 'second']);
    const merged = mergeByAt([{ at: 1, n: 'a' }, { at: 5, n: 'b' }], [{ at: 9, n: 'z' }, { at: 5, n: 'x' }, { at: 0, n: 'w' }, { at: 5, n: 'y' }]);
    expect(merged.map((x) => x.n), 'a batch the same as one by one').toEqual(['w', 'a', 'b', 'x', 'y', 'z']);
    // A list out of order (a system line on this browser's clock, ahead): the same places as one by one, too.
    const list = [{ at: 10, n: 't10' }, { at: 5000, n: 'sys' }, { at: 20, n: 't20' }, { at: 30, n: 't30' }];
    const items = [{ at: 25, n: 's25' }, { at: 1, n: 's1' }];
    expect(mergeByAt(list, items)).toEqual(items.reduce((l, x) => insertByAt(l, x), list));
  });

  it('is answered once per SYNC_COOLDOWN_MS per socket; what goes out to the room is handed over to be kept', async () => {
    const person = { publicKey: 'pkA', fingerprint: 'abc234', profile: 'cHJvZmlsZQ', role: 'visitor' as const, joinSeq: null, sharing: false, muted: false };
    const state: SocketState = { stage: 'attached', person, bucket: newBucket(0), attachedAt: 0 };
    const asked: number[] = [];
    const ctx = { authKey: 'a', now: 1000, others: [], mintIce: async () => ({ iceServers: [], turnUser: null }), history: async (since: number) => { asked.push(since); return [entry(1)]; } };
    const first = await onMessage(state, JSON.stringify({ t: 'sync', since: 42 }), ctx);
    expect((await first.after!()).replies).toEqual([{ t: 'history', entries: [entry(1)], last: true, upTo: 1000 }]);
    expect(asked).toEqual([42]);
    const again = await onMessage(first.state, JSON.stringify({ t: 'sync', since: 42 }), { ...ctx, now: 2000 });
    expect(again.replies).toEqual([{ t: 'error', reason: 'asked too soon', ref: 'sync' }]);
    const later = await onMessage(again.state, JSON.stringify({ t: 'sync', since: 42 }), { ...ctx, now: 11_000 });
    expect(later.after).toBeDefined();
    for (const bad of [-1, 1.5, '7', undefined]) {
      expect((await onMessage(state, JSON.stringify({ t: 'sync', since: bad }), ctx)).replies[0]).toMatchObject({ t: 'error', reason: 'unrecognised message', ref: 'sync' });
    }
    // A piece sent up is answered with whether it is kept, and whether to send it again; kept under its sender, at the
    // Room's clock.
    const tag = 'h'.repeat(43);
    for (const [kept, reply] of [['kept', { ok: true }], ['not today', { ok: false }], ['failed', { ok: false, again: true }]] as const) {
      const calls: unknown[][] = [];
      const out = await onMessage(state, JSON.stringify({ t: 'piece', tag, n: 1, sealed: 'c2Vh' }), { ...ctx, keepPiece: async (...a: unknown[]) => { calls.push(a); return kept; } });
      expect((await out.after!()).replies).toEqual([{ t: 'kept', tag, n: 1, ...reply }]);
      expect(calls).toEqual([['pkA', `${tag}:1`, 'c2Vh', 1000]]);
    }
    const fetched = await onMessage(state, JSON.stringify({ t: 'fetch', tag, n: 1 }), { ...ctx, piece: async (id: string) => (id === `${tag}:1` ? 'c2Vh' : null) });
    expect((await fetched.after!()).replies).toEqual([{ t: 'piece', tag, n: 1, sealed: 'c2Vh' }]);
    const missing = await onMessage(state, JSON.stringify({ t: 'fetch', tag, n: 2 }), { ...ctx, piece: async () => null });
    expect((await missing.after!()).replies).toEqual([{ t: 'piece', tag, n: 2 }]);
    // A forget deletes what this socket's friend wrote, up to the Room's clock or the time it names, once per cooldown.
    const forgets: unknown[][] = [];
    const forget = async (...a: unknown[]) => { forgets.push(a); return forgets.length > 1; };
    const f1 = await onMessage(state, JSON.stringify({ t: 'forget' }), { ...ctx, forget });
    expect((await f1.after!()).replies).toEqual([{ t: 'forgot', before: 1000, done: false }]);
    expect((await onMessage(f1.state, JSON.stringify({ t: 'forget', before: 900 }), { ...ctx, forget, now: 2000 })).replies).toEqual([{ t: 'error', reason: 'asked too soon', ref: 'forget' }]);
    const f2 = await onMessage(f1.state, JSON.stringify({ t: 'forget', before: 900 }), { ...ctx, forget, now: 11_000 });
    expect((await f2.after!()).replies).toEqual([{ t: 'forgot', before: 900, done: true }]);
    expect(forgets).toEqual([['pkA', 1000], ['pkA', 900]]);
    for (const bad of [-1, 1.5, '7', null]) {
      expect((await onMessage(state, JSON.stringify({ t: 'forget', before: bad }), ctx)).replies[0]).toMatchObject({ t: 'error', reason: 'unrecognised message', ref: 'forget' });
    }
    const sent = await onMessage(state, JSON.stringify({ t: 'file', sealed: 'c2Vh', id: 'f1' }), ctx);
    expect(sent.keep).toEqual({ t: 'file', from: { publicKey: 'pkA', fingerprint: 'abc234', profile: 'cHJvZmlsZQ' }, sealed: 'c2Vh', at: 1000, id: 'f1' });
    expect(sent.broadcast).toEqual([sent.keep]);
  });
});

describe('through the Worker', () => {
  function inbox(ws: WebSocket) {
    const frames: ServerMessage[] = [];
    let arrived = () => {};
    ws.addEventListener('message', (e) => { frames.push(JSON.parse(e.data as string)); arrived(); });
    async function until(ok: (m: ServerMessage) => boolean): Promise<ServerMessage> {
      for (;;) {
        const found = frames.find(ok);
        if (found) return found;
        await new Promise<void>((resolve) => { arrived = resolve; });
      }
    }
    return { frames, until };
  }
  async function enter(secret: string, name: string) {
    const keys = await generateIdentityKeyPair();
    const ws = await openRoomSocket(secret);
    const box = inbox(ws);
    const auth = await authFrame((await box.until((m) => m.t === 'challenge')) as Challenge, keys, secret, name);
    ws.send(JSON.stringify(auth));
    await box.until((m) => m.t === 'welcome');
    return { ws, box, publicKey: toBase64Url(await exportPublicKey(keys.publicKey)) };
  }

  it('a friend who was not there gets the texts and files sent meanwhile, and only those of her room', async () => {
    const secret = `kept-${Math.random().toString(36).slice(2)}`;
    const alice = await enter(secret, 'Alice');
    alice.ws.send(JSON.stringify({ t: 'sealed', sealed: 'b25l', id: 'one' }));
    alice.ws.send(JSON.stringify({ t: 'file', sealed: 'ZmlsZQ', id: 'two' }));
    await alice.box.until((m) => m.t === 'file');
    const other = await enter(`${secret}-other`, 'Carol');
    other.ws.send(JSON.stringify({ t: 'sealed', sealed: 'b3RoZXI', id: 'elsewhere' }));
    await other.box.until((m) => m.t === 'sealed');
    // Kept as the Room hands it over, after its broadcast: Bob asks until both are there.
    let entries: KeptEntry[] = [];
    for (let i = 0; i < 50 && entries.length < 2; i++) {
      const bob = await enter(secret, 'Bob');
      bob.ws.send(JSON.stringify({ t: 'sync', since: 0 }));
      entries = ((await bob.box.until((m) => m.t === 'history')) as Extract<ServerMessage, { t: 'history' }>).entries;
      bob.ws.close();
    }
    expect(entries.map((e) => [e.t, e.id, e.sealed, nameOf(e.from.profile), e.from.publicKey])).toEqual([['sealed', 'one', 'b25l', 'Alice', alice.publicKey], ['file', 'two', 'ZmlsZQ', 'Alice', alice.publicKey]]);
    alice.ws.close();
    other.ws.close();
  });

  it('/history-usage says how full the window is, in JSON', async () => {
    forgetHistoryUsage();
    const res = await exports.default.fetch(new Request('https://dave.test/history-usage'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const u = parseHistoryUsage(await res.json());
    expect(u).not.toBeNull();
    expect(u!.budget).toBe(HISTORY_BUDGET_BYTES);
    expect(formatHistoryUsage({ ...u!, bytes: 1_234_567 })).toBe('1.2 MB of 4 GB (<0.1%)');
    expect(formatHistoryUsage({ ...u!, bytes: 3_000_000_000 })).toBe('3 GB of 4 GB (75%)');
    expect(parseHistoryUsage({ error: 'unavailable' })).toBeNull();
    expect(u!.today, 'today\'s use of the shares').toMatchObject({ syncs: expect.any(Number), written: expect.any(Number), read: expect.any(Number) });
    expect(u!.shares).toEqual({ syncs: SYNCS_PER_DAY, written: WRITES_PER_DAY, read: SYNC_ROWS_PER_DAY });
    const old = { bytes: 1, budget: 2, entries: 1, oldest: null, asOf: 3 };
    expect(parseHistoryUsage({ ...old, today: { day: '2026-11-05', syncs: 1, written: 2, read: 3 } }), 'no shares: neither').toEqual(old);
    expect(parseHistoryUsage({ ...old, today: { day: '2026-11-05', syncs: -1, written: 2, read: 3 }, shares: { syncs: 1, written: 1, read: 1 } })).toEqual(old);
  });
});
