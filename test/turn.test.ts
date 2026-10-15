// What becomes of the TURN users the Room mints (ticket 45's leftovers, ticket 47's comments). A friend's peer
// connections may still relay through a user minted on an earlier socket of hers, and media can flow with every socket
// gone, which the server cannot see: so a user is revoked only when its friend leaves the call, and otherwise runs out
// after ICE_TTL_SECONDS. A socket that goes leaves its users for her next join. A user minted for a join the socket has
// left meanwhile never reached anyone and is revoked at once, its answer unsent. Cloudflare's TURN API is a mock here: each mint hands out the next
// user, and one can be held so that something happens to the socket while it is under way.
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentityKeyPair } from '../src/core/identity';
import { CLOSE_SUPERSEDED, type Person, type ServerMessage } from '../src/core/protocol';
import { ICE_TTL_SECONDS } from '../src/core/mesh';
import type { SocketState } from '../src/core/room';
import { roomIdOf } from '../src/core/rooms';
import { CLOSE_SILENT, SILENT_TIMEOUT_MS, type Room } from '../src/worker/room';
import { mintIceServers, revokeIce } from '../src/worker/turn';
import { authFrame, openRoomSocket, type Challenge, type Keys } from './harness';

vi.mock('../src/worker/turn', () => ({ mintIceServers: vi.fn(), revokeIce: vi.fn() }));

/** Longer than any grace there could be: the users minted before it have run out. */
const PAST_THE_TTL_MS = ICE_TTL_SECONDS * 1000 + SILENT_TIMEOUT_MS;

type Client = { ws: WebSocket; you: Person; inbox: ServerMessage[]; next: (pred?: (m: ServerMessage) => boolean) => Promise<ServerMessage>; closed: Promise<number> };

async function attach(secret: string, name: string, keys?: Keys): Promise<Client> {
  const ws = await openRoomSocket(secret);
  const inbox: ServerMessage[] = [];
  const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m);
    else inbox.push(m);
  });
  const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r((e as CloseEvent).code)));
  const next = (pred: (m: ServerMessage) => boolean = () => true) =>
    new Promise<ServerMessage>((resolve) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) resolve(inbox.splice(i, 1)[0]!);
      else waiters.push({ pred, resolve });
    });
  const challenge = (await next((m) => m.t === 'challenge')) as Challenge;
  ws.send(JSON.stringify(await authFrame(challenge, keys ?? await generateIdentityKeyPair(), secret, name)));
  const welcome = (await next((m) => m.t === 'welcome')) as { you: Person };
  return { ws, you: welcome.you, inbox, next, closed };
}

const send = (c: Client, m: object) => c.ws.send(JSON.stringify(m));
const names = (m: ServerMessage) => (m as { people: Person[] }).people.map((p) => p.name).sort();
const roomOf = async (secret: string) => env.ROOM.get(env.ROOM.idFromName(await roomIdOf(secret)));
/**
 * A round trip through the Room: everything it was sent before has been handled, and what it sent back has arrived. A text,
 * which comes back to its sender; a ping would not do, the runtime answers it without waking the Room.
 */
let roundTrips = 0;
const settled = async (c: Client) => {
  const id = `round-trip-${++roundTrips}`;
  send(c, { t: 'sealed', sealed: 'c2VhbGVk', id });
  await c.next((m) => m.t === 'sealed' && m.id === id);
};

/** Every TURN user the mock handed out, in order: plain data, which the Room's code and the test's may share. */
const minted: string[] = [];
const nextUser = () => { const user = `turn-user-${minted.length + 1}`; minted.push(user); return user; };
const revoked = () => vi.mocked(revokeIce).mock.calls.map(([, user]) => user).sort();

beforeEach(() => {
  vi.mocked(revokeIce).mockReset().mockResolvedValue(undefined);
  vi.mocked(mintIceServers).mockReset().mockImplementation(async () => ({ iceServers: [], turnUser: nextUser() }));
});

/**
 * The next mint waits for `release()`; `started()` gives its user once the Room has asked for it. Both sides only poll:
 * a promise that one side resolves runs the other side's code on in the wrong context ("Cannot perform I/O on behalf of
 * a different Durable Object").
 */
function holdNextMint({ stunOnly = false } = {}): { started: () => Promise<string>; release: () => void } {
  let user: string | null = null;
  let released = false;
  vi.mocked(mintIceServers).mockImplementationOnce(async () => {
    const turnUser = nextUser();
    user = turnUser;
    while (!released) await new Promise((r) => setTimeout(r, 5));
    return { iceServers: [], turnUser: stunOnly ? null : turnUser }; // STUN only: Cloudflare's API failed, as it may
  });
  return {
    started: () => vi.waitFor(() => { if (user === null) throw new Error('the Room has not asked for a TURN user yet'); return user; }),
    release: () => { released = true; },
  };
}

/** Joins and returns the TURN user the call was minted with. */
async function join(c: Client): Promise<string> {
  const before = minted.length;
  send(c, { t: 'join', muted: false });
  await c.next((m) => m.t === 'call');
  expect(minted.length).toBe(before + 1);
  return minted[before]!;
}

/** Leaves the call and waits until the Room has said so. */
async function leave(c: Client): Promise<void> {
  send(c, { t: 'leave' });
  await c.next((m) => m.t === 'left' && m.publicKey === c.you.publicKey);
}

/**
 * Moves the Room's clock `ms` on and runs its sweep. The sockets of `fresh` count as having just shown a sign of life;
 * they must not have pinged, since the runtime stamps pings with the real time.
 */
async function sweepAfterKeeping(secret: string, ms: number, fresh: Client[] = []): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + ms);
    await runInDurableObject(await roomOf(secret), (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const s = ws.deserializeAttachment() as SocketState | null;
        if (s?.stage === 'attached' && fresh.some((c) => c.you.publicKey === s.person.publicKey)) ws.serializeAttachment({ ...s, attachedAt: Date.now() });
      }
    });
    expect(await runDurableObjectAlarm(await roomOf(secret))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
}

/** Makes the sockets of `c` look silent past SILENT_TIMEOUT_MS, for the next sweep to drop. */
async function silence(secret: string, c: Client): Promise<void> {
  await runInDurableObject(await roomOf(secret), (_i, state) => {
    for (const ws of state.getWebSockets()) {
      const s = ws.deserializeAttachment() as SocketState | null;
      if (s?.stage === 'attached' && s.person.publicKey === c.you.publicKey) ws.serializeAttachment({ ...s, attachedAt: Date.now() - SILENT_TIMEOUT_MS - 1000 });
    }
  });
}

/** What the Room keeps for friends away, by storage key. */
const awayEntries = async (secret: string) => runInDurableObject(await roomOf(secret), (_i, state) => [...state.storage.kv.list({ prefix: 'away:' })].map(([key]) => key));

describe('a friend who goes without leaving keeps her TURN users: only her Leave revokes them', () => {
  it('swept for silence (a phone with its screen off) and back: nothing is revoked until she leaves the call', async () => {
    const secret = 'turn-sweep-room';
    const keys = await generateIdentityKeyPair();
    const b = await attach(secret, 'Bob');
    await join(b);
    const a = await attach(secret, 'Alice', keys);
    const first = await join(a);
    await silence(secret, a);
    expect(await runDurableObjectAlarm(await roomOf(secret))).toBe(true);
    expect(await a.closed).toBe(CLOSE_SILENT);
    const back = await attach(secret, 'Alice', keys);
    const second = await join(back);
    await settled(back);
    expect(revoked()).toEqual([]); // her peer connections may still relay through the first
    await leave(back);
    await vi.waitFor(() => expect(revoked()).toEqual([first, second].sort()));
    back.ws.close(1000); b.ws.close(1000);
  });

  it('swept from a call that goes on (a phone in a pocket): nothing is revoked while she is away, however long', async () => {
    const secret = 'turn-pocket-room';
    const b = await attach(secret, 'Bob');
    const bobs = await join(b);
    const a = await attach(secret, 'Alice');
    await join(a);
    await silence(secret, a);
    expect(await runDurableObjectAlarm(await roomOf(secret))).toBe(true);
    expect(await a.closed).toBe(CLOSE_SILENT);
    await sweepAfterKeeping(secret, ICE_TTL_SECONDS * 500, [b]); // half the TTL away
    expect(revoked()).toEqual([]);
    await leave(b); // nobody is left in the call that the Room can see, yet her phone may still be talking to his
    await vi.waitFor(() => expect(revoked()).toEqual([bobs]));
    await sweepAfterKeeping(secret, ICE_TTL_SECONDS * 500, [b]);
    expect(revoked()).toEqual([bobs]);
    b.ws.close(1000);
  });

  it('both friends swept (two phones talking with their screens off): the sweeps never revoke, and forget the users once they have run out', async () => {
    const secret = 'turn-both-swept-room';
    const c = await attach(secret, 'Carol'); // keeps the sweeps coming
    const a = await attach(secret, 'Alice');
    await join(a);
    const b = await attach(secret, 'Bob');
    await join(b);
    await silence(secret, a);
    await silence(secret, b);
    expect(await runDurableObjectAlarm(await roomOf(secret))).toBe(true);
    expect(await a.closed).toBe(CLOSE_SILENT);
    expect(await b.closed).toBe(CLOSE_SILENT);
    expect((await awayEntries(secret)).sort()).toEqual([`away:${a.you.publicKey}`, `away:${b.you.publicKey}`].sort());
    await sweepAfterKeeping(secret, SILENT_TIMEOUT_MS, [c]);
    expect(revoked()).toEqual([]);
    await sweepAfterKeeping(secret, PAST_THE_TTL_MS, [c]);
    expect(revoked()).toEqual([]);
    expect(await awayEntries(secret)).toEqual([]);
    c.ws.close(1000);
  });

  it('an entry of a shape the Room does not know (stored by an earlier build) is no entry, and the sweep forgets it', async () => {
    const secret = 'turn-old-shape-room';
    const c = await attach(secret, 'Carol');
    await runInDurableObject(await roomOf(secret), (_i, state) => {
      state.storage.kv.put('away:from-a-list', ['turn-user-old-1']);
      state.storage.kv.put('away:from-an-object', { users: ['turn-user-old-2'] });
    });
    await sweepAfterKeeping(secret, 0, [c]);
    expect(revoked()).toEqual([]);
    expect(await awayEntries(secret)).toEqual([]);
    c.ws.close(1000);
  });

  it('superseded by her own new socket (a reconnect the Room had not noticed): nothing is revoked until she leaves', async () => {
    const secret = 'turn-supersede-room';
    const keys = await generateIdentityKeyPair();
    const a1 = await attach(secret, 'Alice', keys);
    const first = await join(a1);
    const a2 = await attach(secret, 'Alice', keys);
    expect(await a1.closed).toBe(CLOSE_SUPERSEDED);
    const second = await join(a2);
    await settled(a2);
    expect(revoked()).toEqual([]);
    await leave(a2);
    await vi.waitFor(() => expect(revoked()).toEqual([first, second].sort()));
    a2.ws.close(1000);
  });

  it('a socket that drops and comes back: nothing is revoked until she leaves', async () => {
    const secret = 'turn-drop-room';
    const keys = await generateIdentityKeyPair();
    const b = await attach(secret, 'Bob');
    const a = await attach(secret, 'Alice', keys);
    const first = await join(a);
    a.ws.close(1000);
    await b.next((m) => m.t === 'presence' && !names(m).includes('Alice'));
    const back = await attach(secret, 'Alice', keys);
    const second = await join(back);
    await settled(back);
    expect(revoked()).toEqual([]);
    await leave(back);
    await vi.waitFor(() => expect(revoked()).toEqual([first, second].sort()));
    back.ws.close(1000); b.ws.close(1000);
  });

  it('back as a visitor who never joins again (a tab reloaded past its Rejoin): her old user is not hers to hold, nor revoked by a timer', async () => {
    const secret = 'turn-visitor-room';
    const keys = await generateIdentityKeyPair();
    const a = await attach(secret, 'Alice', keys);
    const user = await join(a);
    a.ws.close(1000);
    await a.closed;
    const back = await attach(secret, 'Alice', keys);
    await settled(back);
    await sweepAfterKeeping(secret, SILENT_TIMEOUT_MS, [back]);
    expect(revoked()).toEqual([]);
    expect(await awayEntries(secret)).toEqual([`away:${a.you.publicKey}`]); // not taken over by a socket that did not join
    const again = await join(back);
    await leave(back);
    await vi.waitFor(() => expect(revoked()).toEqual([user, again].sort()));
    back.ws.close(1000);
  });

  it('a socket that errored counts as gone: its TURN user waits for her too, and no sweep revokes it', async () => {
    const secret = 'turn-error-room';
    const b = await attach(secret, 'Bob');
    const bobs = await join(b);
    const a = await attach(secret, 'Alice');
    await join(a);
    await runInDurableObject(await roomOf(secret), async (instance: Room, state) => {
      const ws = state.getWebSockets().find((s) => (s.deserializeAttachment() as { person?: Person } | null)?.person?.publicKey === a.you.publicKey);
      if (!ws) throw new Error("Alice's socket is not in the room");
      await instance.webSocketError(ws);
    });
    await sweepAfterKeeping(secret, 0, [b]);
    expect(revoked()).toEqual([]);
    await leave(b);
    await sweepAfterKeeping(secret, 0, [b]);
    expect(revoked()).toEqual([bobs]);
    a.ws.close(1000); b.ws.close(1000);
  });
});

describe('a TURN user minted for a join the socket has left meanwhile is revoked at once, its answer unsent', () => {
  it('the socket closes while the join\'s TURN user is minted', async () => {
    const secret = 'turn-close-room';
    const b = await attach(secret, 'Bob');
    const a = await attach(secret, 'Alice');
    await b.next((m) => m.t === 'presence' && names(m).includes('Alice'));
    b.inbox.length = 0;
    const mint = holdNextMint();
    send(a, { t: 'join', muted: false });
    const user = await mint.started();
    a.ws.close(1000);
    await b.next((m) => m.t === 'presence' && !names(m).includes('Alice')); // the Room has seen her go
    mint.release();
    await vi.waitFor(() => expect(revoked()).toEqual([user]));
    b.ws.close(1000);
  });

  it('the socket is superseded while the join\'s TURN user is minted', async () => {
    const secret = 'turn-supersede-mint-room';
    const keys = await generateIdentityKeyPair();
    const a1 = await attach(secret, 'Alice', keys);
    const mint = holdNextMint();
    send(a1, { t: 'join', muted: false });
    const user = await mint.started();
    const a2 = await attach(secret, 'Alice', keys);
    expect(await a1.closed).toBe(CLOSE_SUPERSEDED);
    mint.release();
    await vi.waitFor(() => expect(revoked()).toEqual([user]));
    a2.ws.close(1000);
  });

  it('Leave while the join\'s TURN user is minted: revoked, and the late answer is not sent', async () => {
    const secret = 'turn-leave-room';
    const a = await attach(secret, 'Alice');
    const mint = holdNextMint();
    send(a, { t: 'join', muted: false });
    const user = await mint.started();
    send(a, { t: 'leave' });
    await a.next((m) => m.t === 'left');
    mint.release();
    await vi.waitFor(() => expect(revoked()).toEqual([user]));
    await settled(a);
    expect(a.inbox.filter((m) => m.t === 'call')).toEqual([]);
    a.ws.close(1000);
  });

  it('Leave and Join again while the first join\'s TURN user is minted: the first is revoked at once and its answer not sent', async () => {
    // A client from before request ids takes any answer to a join: the late one would hand it a revoked user.
    const secret = 'turn-rejoin-room';
    const a = await attach(secret, 'Alice');
    const mint = holdNextMint();
    send(a, { t: 'join', muted: false });
    const first = await mint.started();
    send(a, { t: 'leave' });
    const second = await join(a);
    mint.release();
    await vi.waitFor(() => expect(revoked()).toEqual([first]));
    await settled(a);
    expect(a.inbox.filter((m) => m.t === 'call')).toEqual([]);
    await leave(a);
    await vi.waitFor(() => expect(revoked()).toEqual([first, second].sort()));
    a.ws.close(1000);
  });

  it('Leave and Join again while the first join\'s mint is under way and comes back STUN only: its answer is not sent either', async () => {
    const secret = 'turn-rejoin-stun-room';
    const a = await attach(secret, 'Alice');
    const mint = holdNextMint({ stunOnly: true });
    send(a, { t: 'join', muted: false });
    await mint.started();
    send(a, { t: 'leave' });
    await join(a);
    mint.release();
    await vi.waitFor(() => expect(vi.mocked(mintIceServers).mock.settledResults.filter((r) => r.type !== 'incomplete')).toHaveLength(2));
    await settled(a);
    expect(a.inbox.filter((m) => m.t === 'call')).toEqual([]);
    a.ws.close(1000);
  });
});
