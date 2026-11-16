// The Room closes a socket once, whatever comes after (worker/room.ts, `end`): the outage of 2026-11-16. A close() repeated
// on a socket whose client the network cut off kept the Room awake, and billed, until the connection ended a quarter of
// an hour later, because the runtime forgets after a second hibernation that the socket was closed. No hibernation in
// here (the tests' Room never sleeps), so these count the Room's calls instead: one per socket.
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { generateIdentityKeyPair } from '../src/core/identity';
import { CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, type ServerMessage, type WirePerson as Person } from '../src/core/protocol';
import { CHALLENGE_TIMEOUT_MS, type SocketState } from '../src/core/room';
import { roomIdOf } from '../src/core/rooms';
import { CLOSE_SILENT, SILENT_TIMEOUT_MS } from '../src/worker/room';
import { authFrame, openRoomSocket, type Challenge, type Keys } from './harness';

/** A room of its own for each test: a socket that never answers its close stays in its room for good. */
const freshSecret = () => `close-once-${Math.random().toString(36).slice(2)}`;
const stubOf = async (secret: string) => env.ROOM.get(env.ROOM.idFromName(await roomIdOf(secret)));

type Client = { ws: WebSocket; you: Person; keys: Keys; closed: Promise<number> };

/** A socket to the room, challenged. `cutOff`: its client never answers a close, as one the network cut off does not. */
async function open(secret: string, cutOff: boolean): Promise<{ ws: WebSocket; challenge: Challenge; next: (t: ServerMessage['t']) => Promise<ServerMessage>; closed: Promise<number> }> {
  const ws = await openRoomSocket(secret, undefined, cutOff);
  const frames: ServerMessage[] = [];
  let arrived = () => {};
  ws.addEventListener('message', (e) => { frames.push(JSON.parse(e.data as string) as ServerMessage); arrived(); });
  const closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve((e as CloseEvent).code)));
  const next = async (t: ServerMessage['t']): Promise<ServerMessage> => {
    for (;;) {
      const i = frames.findIndex((m) => m.t === t);
      if (i >= 0) return frames.splice(i, 1)[0]!;
      await new Promise<void>((resolve) => { arrived = resolve; });
    }
  };
  return { ws, challenge: (await next('challenge')) as Challenge, next, closed };
}

async function attach(secret: string, name: string, { keys, cutOff = false }: { keys?: Keys; cutOff?: boolean } = {}): Promise<Client> {
  const { ws, challenge, next, closed } = await open(secret, cutOff);
  keys ??= await generateIdentityKeyPair();
  ws.send(JSON.stringify(await authFrame(challenge, keys, secret, name)));
  const welcome = (await next('welcome')) as { you: Person };
  return { ws, you: welcome.you, keys, closed };
}

/** The Room's ends of its sockets, with the stage each is in. */
const roomSockets = async (secret: string): Promise<Array<{ ws: WebSocket; state: SocketState | null }>> =>
  runInDurableObject(await stubOf(secret), (_room, state) => state.getWebSockets().map((ws) => ({ ws, state: ws.deserializeAttachment() as SocketState | null })));

/** One sweep, `later` ms from now by the Room's clock. */
async function sweep(secret: string, later = 0): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + later);
    expect(await runDurableObjectAlarm(await stubOf(secret)), 'a sweep was due').toBe(true);
  } finally {
    vi.useRealTimers();
  }
}

describe('the Room closes a socket once', () => {
  let closes: MockInstance<WebSocket['close']>;
  /** How often close() was called on this end of a socket. */
  const closedTimes = (ws: WebSocket): number => closes.mock.contexts.filter((self) => self === ws).length;
  beforeEach(() => { closes = vi.spyOn(WebSocket.prototype, 'close'); });
  afterEach(() => closes.mockRestore());

  it('a superseded socket whose client is gone is not closed again by the sweeps after, nor when its close comes at last', async () => {
    const secret = freshSecret();
    const gone = await attach(secret, 'Alice', { cutOff: true });
    const [old] = await roomSockets(secret);
    const back = await attach(secret, 'Alice', { keys: gone.keys }); // her app reconnected; the Room saw no close of the first
    expect(await gone.closed).toBe(CLOSE_SUPERSEDED);
    expect(closedTimes(old!.ws)).toBe(1);

    for (let i = 0; i < 3; i++) await sweep(secret);
    expect((await roomSockets(secret)).map((s) => s.state?.stage).sort(), 'it is still there, closing: nobody answered').toEqual(['attached', 'closing']);
    expect(closedTimes(old!.ws), 'three sweeps later').toBe(1);

    // Her old connection ends at last, and the Room hears of its close: nothing to answer, it closed first.
    gone.ws.close(1000);
    await vi.waitFor(async () => expect((await roomSockets(secret)).map((s) => s.state?.stage)).toEqual(['attached']));
    expect(closedTimes(old!.ws), 'after its close came').toBe(1);
    back.ws.close(1000);
  });

  it('a socket dropped as silent is not closed again by the sweeps after', async () => {
    const secret = freshSecret();
    const silent = await attach(secret, 'Alice', { cutOff: true });
    const here = await attach(secret, 'Bob');
    const old = (await roomSockets(secret)).find((s) => s.state?.stage === 'attached' && s.state.person.publicKey === silent.you.publicKey)!;
    // Alice has shown no sign of life for too long; Bob's socket is as new as it is, so the sweeps go on for him.
    old.ws.serializeAttachment({ ...(old.state as Extract<SocketState, { stage: 'attached' }>), attachedAt: Date.now() - SILENT_TIMEOUT_MS - 1000 });
    await sweep(secret);
    expect(await silent.closed).toBe(CLOSE_SILENT);
    expect(closedTimes(old.ws)).toBe(1);

    for (let i = 0; i < 3; i++) await sweep(secret);
    expect(closedTimes(old.ws), 'three sweeps later').toBe(1);
    here.ws.close(1000);
  });

  it('a socket that never answered its challenge is closed by one sweep, not by every one after', async () => {
    const secret = freshSecret();
    const here = await attach(secret, 'Bob');
    const stranger = await open(secret, true);
    const old = (await roomSockets(secret)).find((s) => s.state?.stage === 'challenge')!;
    await sweep(secret, CHALLENGE_TIMEOUT_MS + 1);
    expect(await stranger.closed).toBe(CLOSE_AUTH_FAILED);
    expect(closedTimes(old.ws)).toBe(1);

    for (let i = 0; i < 3; i++) await sweep(secret, CHALLENGE_TIMEOUT_MS + 1);
    expect(closedTimes(old.ws), 'three sweeps later').toBe(1);
    here.ws.close(1000);
  });

  it('a socket closed for its wrong answers is not closed again by a sweep', async () => {
    const secret = freshSecret();
    const here = await attach(secret, 'Bob');
    const stranger = await open(secret, true);
    const old = (await roomSockets(secret)).find((s) => s.state?.stage === 'challenge')!;
    for (let i = 0; i < 3; i++) stranger.ws.send('garbage');
    expect(await stranger.closed).toBe(CLOSE_AUTH_FAILED);
    expect(closedTimes(old.ws)).toBe(1);

    for (let i = 0; i < 3; i++) await sweep(secret, CHALLENGE_TIMEOUT_MS + 1);
    expect(closedTimes(old.ws), 'three sweeps later').toBe(1);
    here.ws.close(1000);
  });
});
