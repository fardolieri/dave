import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { answerChallenge, exportPublicKey, fromBase64Url, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { CLOSE_AUTH_FAILED, type ServerMessage } from '../src/core/protocol';

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
  const nonce = fromBase64Url((challenge as { nonce: string }).nonce);
  const { hmac, signature } = await answerChallenge({ secret, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: id.keys.privateKey });
  return { t: 'auth', publicKey: id.publicKey, name, hmac: toBase64Url(hmac), signature: toBase64Url(signature) };
}

describe('worker routing', () => {
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

  it('rejects messages before authentication', async () => {
    const ws = await openSocket();
    await nextMessage(ws); // challenge
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'echo', text: 'hi' }));
    expect(await reply).toEqual({ t: 'error', reason: 'unauthenticated' });
    ws.close();
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
    const nonce = fromBase64Url((challenge as { nonce: string }).nonce);
    const { hmac } = await answerChallenge({ secret: SECRET, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: id.keys.privateKey });
    const { signature } = await answerChallenge({ secret: SECRET, nonce, publicKeyRaw: id.publicKeyRaw, privateKey: impostor.keys.privateKey });
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'auth', publicKey: id.publicKey, name: 'Dave', hmac: toBase64Url(hmac), signature: toBase64Url(signature) }));
    expect(await reply).toEqual({ t: 'error', reason: 'authentication failed' });
    ws.close();
  });

  it('after authentication, ping and echo work and a second auth is refused', async () => {
    const ws = await openSocket();
    const id = await identity();
    const auth = await authMessage(ws, id);
    let reply = nextMessage(ws);
    ws.send(JSON.stringify(auth));
    expect((await reply).t).toBe('welcome');
    reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'ping' }));
    expect(await reply).toEqual({ t: 'pong' });
    reply = nextMessage(ws);
    ws.send(JSON.stringify(auth));
    expect(await reply).toEqual({ t: 'error', reason: 'already authenticated' });
    ws.close();
  });
});
