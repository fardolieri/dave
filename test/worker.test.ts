import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { answerChallenge, exportPublicKey, fromBase64Url, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { CLOSE_AUTH_FAILED, type ServerMessage } from '../src/core/protocol';
import { CHALLENGE_TIMEOUT_MS } from '../src/core/room';
import { authKeyOf, roomIdOf } from '../src/core/rooms';
import { authFrame, openRoomSocket, wsPath, type Challenge } from './harness';

/** A room some test has already entered, so its verifier is set. Tests that need a fresh room make their own secret. */
const SECRET = 'gate-test-room';
const freshSecret = () => `fresh-${Math.random().toString(36).slice(2)}`;

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true }));
}
/** Every frame a socket receives, in order, and a way to wait for the first one of a type. */
function inbox(ws: WebSocket) {
  const frames: ServerMessage[] = [];
  let arrived = () => {};
  ws.addEventListener('message', (e) => { frames.push(JSON.parse(e.data as string)); arrived(); });
  async function until(t: ServerMessage['t']): Promise<ServerMessage> {
    for (;;) {
      const found = frames.find((m) => m.t === t);
      if (found) return found;
      await new Promise<void>((resolve) => { arrived = resolve; });
    }
  }
  return { frames, until };
}
function closed(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e as CloseEvent), { once: true }));
}

async function identity() {
  const keys = await generateIdentityKeyPair();
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  return { keys, publicKeyRaw, publicKey: toBase64Url(publicKeyRaw) };
}

/** Reads the challenge and answers it the way the client would, with the auth key for `secret`. */
async function authMessage(ws: WebSocket, id: Awaited<ReturnType<typeof identity>>, secret = SECRET, name = 'Dave') {
  const challenge = (await nextMessage(ws)) as Challenge;
  expect(challenge.t).toBe('challenge');
  return authFrame(challenge, id.keys, secret, name);
}

/** Enters the shared room once so later tests see a room with its verifier set. */
async function enterOnce(secret: string): Promise<void> {
  const ws = await openRoomSocket(secret);
  const auth = await authMessage(ws, await identity(), secret);
  const reply = nextMessage(ws);
  ws.send(JSON.stringify(auth));
  expect((await reply).t).toBe('welcome');
  ws.close();
}

describe('worker routing', () => {
  it.skipIf(!('UPGRADE_LIMIT' in env))('rate-limits upgrade attempts per IP', async () => {
    const ip = '203.0.113.9';
    const path = await wsPath(freshSecret());
    // This address's attempts are used up on the binding itself, which the Worker asks with the same key. Through the Worker
    // each one also opens a socket in a Room: nightly's limit of 120 (ci.yml and deploy.yml run the tests with
    // CLOUDFLARE_ENV=nightly) took up to 5 s that way on a busy runner, past the test's timeout, and the loop went on
    // opening and closing sockets under the tests after it (ticket 45).
    // The limiter's windows are aligned to the wall clock: one that rolls over between using up and the attempt starts
    // counting from zero, so the attempt gets in. That can only happen once a minute; the next round finds the new window.
    // The attempts go 40 at a time: in Miniflare each one is a round trip to the limiter's own Durable Object and a write
    // there, and nightly's 121 one after the other are the likely reason this took past 5 s again on a busy runner (ci.yml
    // run 38298003264, ticket 45's comments).
    let status = 0;
    for (let round = 0; round < 3 && status !== 429; round++) {
      for (let n = 0; n < 25 && (await Promise.all(Array.from({ length: 40 }, () => env.UPGRADE_LIMIT.limit({ key: ip })))).every((r) => r.success); n++);
      const res = await exports.default.fetch(new Request(`https://dave.test${path}`, { headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip } }));
      status = res.status;
      res.webSocket?.accept();
      res.webSocket?.close();
    }
    expect(status).toBe(429);
  });
  it('serves 404 for unknown paths (assets are handled by the platform)', async () => {
    expect((await exports.default.fetch('https://dave.test/nope')).status).toBe(404);
  });
  it('serves 404 for /ws without a room id, and for a malformed one', async () => {
    const headers = { Upgrade: 'websocket' };
    expect((await exports.default.fetch(new Request('https://dave.test/ws', { headers }))).status).toBe(404);
    expect((await exports.default.fetch(new Request('https://dave.test/ws/', { headers }))).status).toBe(404);
    expect((await exports.default.fetch(new Request('https://dave.test/ws/not-a-room-id', { headers }))).status).toBe(404);
  });
  it('refuses a room path without an upgrade', async () => {
    expect((await exports.default.fetch(`https://dave.test${await wsPath(SECRET)}`)).status).toBe(426);
  });
});

describe('gate', () => {
  it('a room nobody has entered says so, takes its verifier from the first correct answer, and is a normal room after that', async () => {
    const secret = freshSecret();
    const a = await openRoomSocket(secret);
    const first = (await nextMessage(a)) as Challenge;
    expect(first).toMatchObject({ t: 'challenge', fresh: true });
    const id = await identity();
    const reply = nextMessage(a);
    a.send(JSON.stringify(await authFrame(first, id.keys, secret, 'Dave')));
    expect((await reply).t).toBe('welcome');
    // From now on the challenge is not fresh and an answer without the key works.
    const b = await openRoomSocket(secret);
    const second = (await nextMessage(b)) as Challenge;
    expect(second.fresh).toBeUndefined();
    const replyB = nextMessage(b);
    b.send(JSON.stringify(await authFrame(second, (await identity()).keys, secret, 'Eve')));
    expect((await replyB).t).toBe('welcome');
    a.close(); b.close();
  });

  it('a fresh room refuses an answer that brings no auth key', async () => {
    const ws = await openRoomSocket(freshSecret());
    const challenge = (await nextMessage(ws)) as Challenge;
    const id = await identity();
    const { authKey: _dropped, ...withoutKey } = await authFrame(challenge, id.keys, SECRET, 'Dave');
    const reply = nextMessage(ws);
    ws.send(JSON.stringify(withoutKey));
    expect(await reply).toEqual({ t: 'error', reason: 'unknown room' });
    ws.close();
  });

  it('once set, the verifier cannot be replaced by a later answer carrying another key', async () => {
    const secret = freshSecret();
    await enterOnce(secret);
    const ws = await openRoomSocket(secret);
    const challenge = (await nextMessage(ws)) as Challenge;
    const id = await identity();
    // An impostor who knows the room id but not the secret: a self-made key, offered as if the room were fresh.
    const fake = await authKeyOf('not the secret');
    const auth = await authFrame({ ...challenge, fresh: true }, id.keys, 'not the secret', 'Mallory');
    expect(auth.authKey).toBe(fake);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify(auth));
    expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    ws.close();
  });

  it('challenges on connect and welcomes a correct answer with the identity', async () => {
    await enterOnce(SECRET);
    const ws = await openRoomSocket(SECRET);
    const id = await identity();
    const auth = await authMessage(ws, id);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify(auth));
    const welcome = await reply;
    expect(welcome.t).toBe('welcome');
    const you = (welcome as { you: { publicKey: string; fingerprint: string; name: string } }).you;
    expect(you.publicKey).toBe(id.publicKey);
    expect(you.name).toBe('Dave');
    expect(you.fingerprint).toMatch(/^[a-z2-9]{6}$/);
    ws.close();
  });

  it('counts every bad frame before authentication as a strike and closes on the third', async () => {
    const ws = await openRoomSocket(SECRET);
    await nextMessage(ws); // challenge
    let reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'text', text: 'hi' }));
    expect(await reply).toEqual({ t: 'error', reason: 'unauthenticated' });
    reply = nextMessage(ws);
    ws.send('garbage');
    expect(await reply).toEqual({ t: 'error', reason: 'unrecognised message' });
    const done = closed(ws);
    // base64url of length 1 mod 4 used to throw inside decoding and bypass the counter
    ws.send(JSON.stringify({ t: 'auth', publicKey: 'aaaaa', name: 'x', hmac: 'aa', signature: 'aa' }));
    expect((await done).code).toBe(CLOSE_AUTH_FAILED);
  });

  it('closes sockets that never answer the challenge when the sweep alarm fires', async () => {
    const ws = await openRoomSocket(SECRET);
    await nextMessage(ws); // challenge
    const done = closed(ws);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + CHALLENGE_TIMEOUT_MS + 1);
      const stub = env.ROOM.get(env.ROOM.idFromName(await roomIdOf(SECRET)));
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect((await done).code).toBe(CLOSE_AUTH_FAILED);
  });

  it('rejects an answer for the wrong secret and closes after three failures', async () => {
    await enterOnce(SECRET);
    const ws = await openRoomSocket(SECRET);
    const id = await identity();
    const auth = await authMessage(ws, id, 'wrong-secret');
    for (let i = 0; i < 2; i++) {
      const reply = nextMessage(ws);
      ws.send(JSON.stringify(auth));
      expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    }
    const done = closed(ws);
    ws.send(JSON.stringify(auth));
    const ev = await done;
    expect(ev.code).toBe(CLOSE_AUTH_FAILED);
  });

  it('rejects a replayed transcript on a new socket', async () => {
    await enterOnce(SECRET);
    const a = await openRoomSocket(SECRET);
    const id = await identity();
    const auth = await authMessage(a, id);
    a.close();
    const b = await openRoomSocket(SECRET);
    await nextMessage(b); // fresh challenge, different nonce
    const reply = nextMessage(b);
    b.send(JSON.stringify(auth));
    expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    b.close();
  });

  it('rejects a signature from a different key', async () => {
    await enterOnce(SECRET);
    const ws = await openRoomSocket(SECRET);
    const id = await identity();
    const impostor = await identity();
    const challenge = await nextMessage(ws);
    const nonce = fromBase64Url((challenge as { nonce: string }).nonce)!;
    const authKey = await authKeyOf(SECRET);
    const { hmac } = await answerChallenge({ authKey, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: id.keys.privateKey });
    const { signature } = await answerChallenge({ authKey, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: impostor.keys.privateKey });
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'auth', publicKey: id.publicKey, name: 'Dave', hmac: toBase64Url(hmac), signature: toBase64Url(signature) }));
    expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    ws.close();
  });

  it('after authentication a second auth is refused', async () => {
    const ws = await openRoomSocket(SECRET);
    const id = await identity();
    const auth = await authMessage(ws, id);
    const box = inbox(ws);
    ws.send(JSON.stringify(auth));
    await box.until('welcome');
    // Presence snapshots come and go meanwhile (this one's join, and leaves of earlier tests' friends in the shared room).
    ws.send(JSON.stringify(auth));
    expect(await box.until('error')).toEqual({ t: 'error', reason: 'already authenticated', ref: 'auth' });
    expect(box.frames.filter((m) => m.t !== 'presence').map((m) => m.t)).toEqual(['welcome', 'error']);
    ws.close();
  });

  it('a socket that leaves without ever authenticating sends no presence to the people in the room', async () => {
    const secret = freshSecret();
    const a = await openRoomSocket(secret);
    const box = inbox(a);
    const auth = await authFrame((await box.until('challenge')) as Challenge, (await identity()).keys, secret, 'Dave');
    a.send(JSON.stringify(auth));
    await box.until('presence');
    // Strangers at the gate: each gets its challenge and goes. Presence did not change, so Dave hears nothing of it.
    // Several, so a close the Room handles late still shows before the sentinel below.
    for (let i = 0; i < 5; i++) {
      const s = await openRoomSocket(secret);
      await nextMessage(s); // challenge
      const done = closed(s);
      s.close();
      await done;
    }
    // A reply Dave is sure to get, after anything the closes made the Room send him.
    a.send(JSON.stringify(auth));
    await box.until('error');
    expect(box.frames.map((m) => m.t)).toEqual(['challenge', 'welcome', 'presence', 'error']);
    a.close();
  });
});
