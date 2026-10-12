// What becomes of the TURN users the Room mints (ticket 45's leftovers, ticket 47's comments). A friend's live peer
// connections may still relay through a user minted on an earlier socket of hers, so a user is revoked only when she
// leaves the call, or stays away from the room past TURN_AWAY_GRACE_MS; a socket that goes hands its users to her next
// one. A user minted for a join the socket has left meanwhile never reached anyone and is revoked at once, its answer
// unsent. Cloudflare's TURN API is a mock here: each mint hands out the next user, and one can be held so that something
// happens to the socket while it is under way.
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentityKeyPair } from '../src/core/identity';
import { CLOSE_SUPERSEDED, type Person, type ServerMessage } from '../src/core/protocol';
import type { SocketState } from '../src/core/room';
import { roomIdOf } from '../src/core/rooms';
import { CLOSE_SILENT, SILENT_TIMEOUT_MS, TURN_AWAY_GRACE_MS, type Room } from '../src/worker/room';
import { mintIceServers, revokeIce } from '../src/worker/turn';
import { authFrame, openRoomSocket, type Challenge, type Keys } from './harness';

vi.mock('../src/worker/turn', () => ({ mintIceServers: vi.fn(), revokeIce: vi.fn() }));

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
/** A round trip through the Room: everything it was sent before has been handled. */
const settled = async (c: Client) => { send(c, { t: 'ping' }); await c.next((m) => m.t === 'pong'); };

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
function holdNextMint(): { started: () => Promise<string>; release: () => void } {
  let user: string | null = null;
  let released = false;
  vi.mocked(mintIceServers).mockImplementationOnce(async () => {
    const turnUser = nextUser();
    user = turnUser;
    while (!released) await new Promise((r) => setTimeout(r, 5));
    return { iceServers: [], turnUser };
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

/** Moves the Room's clock past `ms` from now and runs its sweep. */
async function sweepAfter(secret: string, ms: number): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + ms);
    expect(await runDurableObjectAlarm(await roomOf(secret))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
}

describe('a friend who goes without leaving keeps her TURN users for her next socket', () => {
  it('swept for silence (a phone with its screen off) and back: nothing is revoked until she leaves the call', async () => {
    const secret = 'turn-sweep-room';
    const keys = await generateIdentityKeyPair();
    const a = await attach(secret, 'Alice', keys);
    const first = await join(a);
    await runInDurableObject(await roomOf(secret), (_i, state) => {
      for (const ws of state.getWebSockets()) {
        const s = ws.deserializeAttachment() as SocketState | null;
        if (s?.stage === 'attached' && s.person.publicKey === a.you.publicKey) ws.serializeAttachment({ ...s, attachedAt: Date.now() - SILENT_TIMEOUT_MS - 1000 });
      }
    });
    expect(await runDurableObjectAlarm(await roomOf(secret))).toBe(true);
    expect(await a.closed).toBe(CLOSE_SILENT);
    const back = await attach(secret, 'Alice', keys);
    const second = await join(back);
    await settled(back);
    expect(revoked()).toEqual([]); // her peer connections may still relay through the first
    await leave(back);
    await vi.waitFor(() => expect(revoked()).toEqual([first, second].sort()));
    back.ws.close(1000);
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

  it('a friend who stays away past the grace has her TURN users revoked by the sweep, not before', async () => {
    const secret = 'turn-away-room';
    const a = await attach(secret, 'Alice');
    const user = await join(a);
    a.ws.close(1000);
    await a.closed;
    await sweepAfter(secret, TURN_AWAY_GRACE_MS - 60_000);
    expect(revoked()).toEqual([]);
    await sweepAfter(secret, TURN_AWAY_GRACE_MS + 1000);
    expect(revoked()).toEqual([user]);
  });

  it('a socket that errored counts as gone: its TURN user waits for her too, then the grace', async () => {
    const secret = 'turn-error-room';
    const a = await attach(secret, 'Alice');
    const user = await join(a);
    await runInDurableObject(await roomOf(secret), async (instance: Room, state) => {
      const ws = state.getWebSockets().find((s) => (s.deserializeAttachment() as { person?: Person } | null)?.person?.publicKey === a.you.publicKey);
      if (!ws) throw new Error("Alice's socket is not in the room");
      await instance.webSocketError(ws);
    });
    expect(revoked()).toEqual([]);
    await sweepAfter(secret, TURN_AWAY_GRACE_MS + 1000);
    expect(revoked()).toEqual([user]);
    a.ws.close(1000);
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
});
