import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HISTORY_BUDGET_BYTES, KEPT_FILE_MAX, ROW_OVERHEAD_BYTES, keptKind, WRITES_PER_DAY, SYNCS_PER_DAY, SYNC_FRAME_BYTES, SYNC_ROWS_PER_DAY, SYNC_OVERLAP_MS, entryBytes, formatHistoryUsage, historyFrames, parseHistoryUsage, syncSince } from '../src/core/kept';
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

const entry = (n: number, over: Partial<KeptEntry> = {}): KeptEntry => ({
  t: 'sealed', from: { publicKey: `pk${n % 3}`, fingerprint: 'abc234', profile: 'cHJvZmlsZQ' }, sealed: 'c2VhbGVk'.repeat(40), at: 1_762_250_000_000 + n, id: `id${n}`, ...over,
});
/** A Store of its own per test: the window is the object's, and tests must not see each other's entries. */
const store = (name: string) => env.STORE.get(env.STORE.idFromName(name));

describe('the Store', () => {
  it('keeps entries per room, once per writer and id, and gives the newest after a time, oldest first', async () => {
    await runInDurableObject(store('keeps'), (s: Store) => {
      for (let n = 1; n <= 6; n++) s.keep('roomA', entry(n));
      s.keep('roomB', entry(7));
      // The writer's app sent text 2 again after a lost socket: the Room broadcast it again, with a later time.
      s.keep('roomA', entry(2, { at: 1_762_250_000_100 }));
      expect(s.since('roomA', 0, 500)!.map((e) => e.id)).toEqual(['id1', 'id2', 'id3', 'id4', 'id5', 'id6']);
      expect(s.since('roomA', 1_762_250_000_003, 500)!.map((e) => e.id), 'after a time only').toEqual(['id4', 'id5', 'id6']);
      expect(s.since('roomA', 0, 2)!.map((e) => e.id), 'the newest of them').toEqual(['id5', 'id6']);
      expect(s.since('roomB', 0, 500)).toEqual([entry(7)]);
      expect(s.since('roomC', 0, 500)).toEqual([]);
      expect(s.usage(5)).toEqual({ bytes: 7 * entryBytes(JSON.stringify(entry(1))), budget: HISTORY_BUDGET_BYTES, entries: 7, oldest: entry(1).at, asOf: 5 });
    });
  });

  it('keeps the pieces of a file in the same window as the texts, gives them back one by one, and never in a sync', async () => {
    await runInDurableObject(store('pieces'), (s: Store) => {
      const piece = (fill: number, size = 1000) => new Uint8Array(size).fill(fill);
      expect(s.keepPiece('roomA', 'hashA:0', piece(1))).toBe(true);
      s.keep('roomA', entry(1));
      expect(s.keepPiece('roomA', 'hashA:1', piece(2))).toBe(true);
      expect(s.keepPiece('roomA', 'hashA:1', piece(9)), 'sent again after a lost socket: kept once').toBe(true);
      expect(s.piece('roomA', 'hashA:1')).toEqual(piece(2));
      expect(s.piece('roomA', 'hashA:2'), 'not kept').toBeNull();
      expect(s.piece('roomB', 'hashA:0'), "another room's").toBeNull();
      expect(s.since('roomA', 0, 500)!.map((e) => e.id), 'a sync brings texts and announcements only').toEqual(['id1']);
      expect(s.usage().entries).toBe(3);
      expect(s.usage().bytes).toBe(2 * (1000 + ROW_OVERHEAD_BYTES) + entryBytes(JSON.stringify(entry(1))));
    });
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
      expect(s.keepPiece('roomA', 'hashA:0', new Uint8Array(size * 10 - ROW_OVERHEAD_BYTES), budget)).toBe(true);
      expect(s.since('roomA', 0, 500)!.map((e) => e.id)).toEqual(Array.from({ length: 40 }, (_, i) => text(i + 11).id));
      expect(written() - before, 'the texts dropped count against the day too, as SQLite counts rows written').toBeGreaterThanOrEqual(10 + 1);
      expect(s.usage().bytes).toBe(budget);
      // The window keeps its order: the piece goes before texts kept after it.
      for (let n = 51; n <= 90; n++) s.keep('roomA', text(n), budget);
      expect(s.piece('roomA', 'hashA:0'), 'the texts before it go first').not.toBeNull();
      for (let n = 91; n <= 100; n++) s.keep('roomA', text(n), budget);
      expect(s.piece('roomA', 'hashA:0')).toBeNull();
    });
  });

  it('a fetch that finds nothing writes nothing, and counts what it read against the day\'s share', async () => {
    await runInDurableObject(store('misses'), (s: Store, state) => {
      const day = Date.UTC(2026, 10, 5, 10);
      s.keepPiece('roomA', 'hashA:0', new Uint8Array(10), HISTORY_BUDGET_BYTES, day);
      const totals = () => state.storage.sql.exec<{ kept: number; read: number }>('SELECT kept, read FROM totals').one();
      const before = totals();
      for (let i = 0; i < 5; i++) expect(s.piece('roomA', `nothing:${i}`, day)).toBeNull();
      expect(totals(), 'no write for a miss').toEqual(before);
      // Misses that read the day's share away: then nothing is given, not even what is kept, nor a sync.
      (s as unknown as { missed: { day: string; rows: number } }).missed = { day: '2026-11-05', rows: SYNC_ROWS_PER_DAY };
      expect(s.piece('roomA', 'hashA:0', day)).toBeNull();
      expect(s.since('roomA', 0, 500, day)).toBeNull();
      expect(s.piece('roomA', 'hashA:0', day + 24 * 3600_000), 'the day after').toEqual(new Uint8Array(10));
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

  it('asks from where it last had everything less the overlap, from where it was cleared at the earliest, from the start for nothing', () => {
    expect(syncSince(null, null)).toBe(0);
    expect(syncSince(1_000_000_000, null)).toBe(1_000_000_000 - SYNC_OVERLAP_MS);
    expect(syncSince(1_000_000_000, 1_000_000_500)).toBe(1_000_000_500);
    expect(syncSince(null, 7)).toBe(7);
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
    // A piece sent up is answered with whether it is kept, and whether to send it again.
    const hash = 'h'.repeat(43);
    for (const [kept, reply] of [['kept', { ok: true }], ['not today', { ok: false }], ['failed', { ok: false, again: true }]] as const) {
      const out = await onMessage(state, JSON.stringify({ t: 'piece', hash, n: 1, sealed: 'c2Vh' }), { ...ctx, keepPiece: async () => kept });
      expect((await out.after!()).replies).toEqual([{ t: 'kept', hash, n: 1, ...reply }]);
    }
    const fetched = await onMessage(state, JSON.stringify({ t: 'fetch', hash, n: 1 }), { ...ctx, piece: async (id: string) => (id === `${hash}:1` ? 'c2Vh' : null) });
    expect((await fetched.after!()).replies).toEqual([{ t: 'piece', hash, n: 1, sealed: 'c2Vh' }]);
    const missing = await onMessage(state, JSON.stringify({ t: 'fetch', hash, n: 2 }), { ...ctx, piece: async () => null });
    expect((await missing.after!()).replies).toEqual([{ t: 'piece', hash, n: 2 }]);
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
  });
});
