// The Room's sweep runs while friends are together, not for a friend alone (worker/room.ts, SWEEP_FROM): every sweep is a
// request to the Room, billed against the free plan's day, and on 2026-11-17 the sweep was most of the live site's
// (ticket 89). A ghost a friend alone left behind is dropped as the next friend comes in, before she is told who is there.
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { generateIdentityKeyPair } from '../src/core/identity';
import { type ServerMessage, type WirePerson as Person } from '../src/core/protocol';
import { CHALLENGE_TIMEOUT_MS, type SocketState } from '../src/core/room';
import { roomIdOf } from '../src/core/rooms';
import { CLOSE_SILENT, SILENT_TIMEOUT_MS } from '../src/worker/room';
import { authFrame, openRoomSocket, type Challenge } from './harness';

const freshSecret = () => `sweep-${Math.random().toString(36).slice(2)}`;
const stubOf = async (secret: string) => env.ROOM.get(env.ROOM.idFromName(await roomIdOf(secret)));

type Friend = { ws: WebSocket; you: Person; frames: ServerMessage[]; closed: Promise<number> };

/** A friend let into the room. `cutOff`: her client answers no close, as one the network cut off does not. */
async function enter(secret: string, name: string, cutOff = false): Promise<Friend> {
  const ws = await openRoomSocket(secret, undefined, cutOff);
  const frames: ServerMessage[] = [];
  let arrived = () => {};
  ws.addEventListener('message', (e) => { frames.push(JSON.parse(e.data as string) as ServerMessage); arrived(); });
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve((e as CloseEvent).code)));
  const next = async (t: ServerMessage['t']): Promise<ServerMessage> => {
    for (;;) {
      const found = frames.find((m) => m.t === t);
      if (found) return found;
      await new Promise<void>((resolve) => { arrived = resolve; });
    }
  };
  const challenge = (await next('challenge')) as Challenge;
  ws.send(JSON.stringify(await authFrame(challenge, await generateIdentityKeyPair(), secret, name)));
  const { you } = (await next('welcome')) as { you: Person };
  await next('presence');
  return { ws, you, frames, closed };
}

/** When the Room's alarm is set for, or null for none. */
const alarmOf = async (secret: string) => runInDurableObject(await stubOf(secret), (_room, state) => state.storage.getAlarm());

/** The alarm run `later` ms from now by the Room's clock; whether one was due. */
async function sweep(secret: string, later: number): Promise<boolean> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + later);
    return await runDurableObjectAlarm(await stubOf(secret));
  } finally {
    vi.useRealTimers();
  }
}

/** Makes `friend` silent for longer than the sweep allows, as one whose line went dead without a close. */
const silence = async (secret: string, friend: Friend) => runInDurableObject(await stubOf(secret), (_room, state) => {
  for (const ws of state.getWebSockets()) {
    const s = ws.deserializeAttachment() as SocketState | null;
    if (s?.stage === 'attached' && s.person.publicKey === friend.you.publicKey) ws.serializeAttachment({ ...s, attachedAt: Date.now() - SILENT_TIMEOUT_MS - 1000 });
  }
});

describe('the sweep runs while friends are together', () => {
  it('a friend alone in the room keeps no alarm once her challenge is answered', async () => {
    const secret = freshSecret();
    const alice = await enter(secret, 'Alice');
    expect(await sweep(secret, CHALLENGE_TIMEOUT_MS + 1), "the challenge's window").toBe(true);
    expect(await alarmOf(secret), 'nothing after it: nobody to tell of a ghost').toBeNull();
    alice.ws.close(1000);
  });

  it('two friends together are swept every minute, and a ghost among them goes within it', async () => {
    const secret = freshSecret();
    const alice = await enter(secret, 'Alice', true);
    const bob = await enter(secret, 'Bob');
    expect(await sweep(secret, CHALLENGE_TIMEOUT_MS + 1)).toBe(true);
    expect(await alarmOf(secret), 'the next sweep').not.toBeNull();
    await silence(secret, alice);
    expect(await sweep(secret, 0)).toBe(true);
    expect(await alice.closed).toBe(CLOSE_SILENT);
    const last = bob.frames.filter((m) => m.t === 'presence').at(-1) as Extract<ServerMessage, { t: 'presence' }>;
    expect(last.people.map((p) => p.publicKey), 'Bob is told she went').toEqual([bob.you.publicKey]);
    expect(await alarmOf(secret), 'Bob alone now: no more sweeps').toBeNull();
    bob.ws.close(1000);
  });

  it('a ghost left alone in the room is dropped as the next friend comes in, before she is told who is there', async () => {
    const secret = freshSecret();
    const alice = await enter(secret, 'Alice', true);
    expect(await sweep(secret, CHALLENGE_TIMEOUT_MS + 1)).toBe(true);
    await silence(secret, alice); // her line went dead, and no sweep looked
    const bob = await enter(secret, 'Bob');
    expect(await alice.closed).toBe(CLOSE_SILENT);
    for (const m of bob.frames.filter((f) => f.t === 'presence') as Array<Extract<ServerMessage, { t: 'presence' }>>) {
      expect(m.people.map((p) => p.publicKey), 'never Alice').toEqual([bob.you.publicKey]);
    }
    bob.ws.close(1000);
  });

  it("a ghost that cannot be dropped as the next friend comes in (the day's rows written used up) does not keep her out", async () => {
    const secret = freshSecret();
    const alice = await enter(secret, 'Alice', true);
    expect(await sweep(secret, CHALLENGE_TIMEOUT_MS + 1)).toBe(true);
    await runInDurableObject(await stubOf(secret), (_room, state) => {
      for (const ws of state.getWebSockets()) {
        const s = ws.deserializeAttachment() as SocketState | null;
        // Silent, with a TURN user to keep for her: the write that keeps it fails, once.
        if (s?.stage === 'attached') ws.serializeAttachment({ ...s, attachedAt: Date.now() - SILENT_TIMEOUT_MS - 1000, turnUsers: ['a-turn-user'] });
      }
      const kv = state.storage.kv as unknown as { put: (...args: unknown[]) => unknown };
      const put = kv.put;
      kv.put = () => { kv.put = put; throw new Error('Exceeded allowed rows written in Durable Objects free tier.'); };
    });
    const bob = await enter(secret, 'Bob');
    expect(bob.you.publicKey, 'let in all the same').toBeTruthy();
    expect(await alice.closed).toBe(CLOSE_SILENT);
    for (const m of bob.frames.filter((f) => f.t === 'presence') as Array<Extract<ServerMessage, { t: 'presence' }>>) {
      expect(m.people.map((p) => p.publicKey), 'and never told of her').toEqual([bob.you.publicKey]);
    }
    bob.ws.close(1000);
  });

  it('two friends together start the sweep as the second is let in, not only by the alarm her challenge set', async () => {
    const secret = freshSecret();
    const alice = await enter(secret, 'Alice');
    expect(await sweep(secret, CHALLENGE_TIMEOUT_MS + 1)).toBe(true);
    expect(await alarmOf(secret)).toBeNull();
    // Bob's socket opens, and the alarm its challenge set is lost (a sweep that failed before it set the next, say).
    const ws = await openRoomSocket(secret);
    const challenge = await new Promise<Challenge>((resolve) => ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data as string) as ServerMessage;
      if (m.t === 'challenge') resolve(m);
    }));
    await runInDurableObject(await stubOf(secret), (_room, state) => state.storage.deleteAlarm());
    const welcomed = new Promise<void>((resolve) => ws.addEventListener('message', (e) => { if ((JSON.parse(e.data as string) as ServerMessage).t === 'welcome') resolve(); }));
    ws.send(JSON.stringify(await authFrame(challenge, await generateIdentityKeyPair(), secret, 'Bob')));
    await welcomed;
    const at = await alarmOf(secret);
    expect(at, 'the sweep, set as he was let in').not.toBeNull();
    expect(at! - Date.now()).toBeGreaterThan(CHALLENGE_TIMEOUT_MS);
    alice.ws.close(1000); ws.close(1000);
  });
});
