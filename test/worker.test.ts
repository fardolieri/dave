import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { answerChallenge, buildAuthMessage, exportPublicKey, fromBase64Url, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { CLOSE_AUTH_FAILED, type ServerMessage } from '../src/core/protocol';
import { CHALLENGE_TIMEOUT_MS } from '../src/core/room';

const SECRET = 'test-secret'; // matches vitest.config.ts

async function openSocket(): Promise<WebSocket> {
  const res = await exports.default.fetch(new Request('https://dave.test/ws', { headers: { Upgrade: 'websocket' } }));
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no websocket on 101 response');
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true }));
}
function closed(ws: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e as CloseEvent), { once: true }));
}

async function identity() {
  const keys = await generateIdentityKeyPair();
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  return { keys, publicKeyRaw, publicKey: toBase64Url(publicKeyRaw) };
}

async function authMessage(ws: WebSocket, id: Awaited<ReturnType<typeof identity>>, secret = SECRET, name = 'Dave') {
  const challenge = await nextMessage(ws);
  expect(challenge.t).toBe('challenge');
  return buildAuthMessage({ secret, nonce: (challenge as { nonce: string }).nonce, publicKeyRaw: id.publicKeyRaw, privateKey: id.keys.privateKey, name });
}

describe('worker routing', () => {
  it.skipIf(!('UPGRADE_LIMIT' in env))('rate-limits upgrade attempts per IP', async () => {
    const headers = { Upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.9' };
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await exports.default.fetch(new Request('https://dave.test/ws', { headers }));
      last = res.status;
      res.webSocket?.accept();
      res.webSocket?.close();
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
  it('serves 404 for unknown paths (assets are handled by the platform)', async () => {
    expect((await exports.default.fetch('https://dave.test/nope')).status).toBe(404);
  });
  it('refuses /ws without an upgrade', async () => {
    expect((await exports.default.fetch('https://dave.test/ws')).status).toBe(426);
  });
});

describe('gate', () => {
  it('challenges on connect and welcomes a correct answer with the identity', async () => {
    const ws = await openSocket();
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
    const ws = await openSocket();
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
    const ws = await openSocket();
    await nextMessage(ws); // challenge
    const done = closed(ws);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + CHALLENGE_TIMEOUT_MS + 1);
      const stub = env.ROOM.get(env.ROOM.idFromName('the-room'));
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect((await done).code).toBe(CLOSE_AUTH_FAILED);
  });

  it('rejects a wrong secret and closes after three failures', async () => {
    const ws = await openSocket();
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
    const a = await openSocket();
    const id = await identity();
    const auth = await authMessage(a, id);
    a.close();
    const b = await openSocket();
    await nextMessage(b); // fresh challenge, different nonce
    const reply = nextMessage(b);
    b.send(JSON.stringify(auth));
    expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    b.close();
  });

  it('rejects a signature from a different key', async () => {
    const ws = await openSocket();
    const id = await identity();
    const impostor = await identity();
    const challenge = await nextMessage(ws);
    const nonce = fromBase64Url((challenge as { nonce: string }).nonce)!;
    const { hmac } = await answerChallenge({ secret: SECRET, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: id.keys.privateKey });
    const { signature } = await answerChallenge({ secret: SECRET, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: impostor.keys.privateKey });
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'auth', publicKey: id.publicKey, name: 'Dave', hmac: toBase64Url(hmac), signature: toBase64Url(signature) }));
    expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    ws.close();
  });

  it('after authentication a second auth is refused', async () => {
    const ws = await openSocket();
    const id = await identity();
    const auth = await authMessage(ws, id);
    let reply = nextMessage(ws);
    ws.send(JSON.stringify(auth));
    expect((await reply).t).toBe('welcome');
    // the welcome is followed by a presence snapshot; skip it
    await nextMessage(ws);
    reply = nextMessage(ws);
    ws.send(JSON.stringify(auth));
    expect(await reply).toEqual({ t: 'error', reason: 'already authenticated' });
    ws.close();
  });
});
