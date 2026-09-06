import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { Room } from '../src/worker/room';
import { describe, expect, it } from 'vitest';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { MAX_TEXT_LENGTH, PING_FRAME, PONG_FRAME, type Person, type ServerMessage } from '../src/core/protocol';
import { BURST } from '../src/core/ratelimit';

const SECRET = 'test-secret';

type Client = { ws: WebSocket; you: Person; inbox: ServerMessage[]; next: (pred?: (m: ServerMessage) => boolean) => Promise<ServerMessage> };

/** Opens and authenticates a visitor (attaches a socket), returning a client whose inbox records everything after the welcome. */
async function attach(name: string): Promise<Client> {
  // a distinct client address per socket, so the per-IP upgrade limit never trips inside a test file
  const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const res = await exports.default.fetch(new Request('https://dave.test/ws', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip } }));
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ServerMessage[] = [];
  const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(m); // handed to a waiter, not kept
    else inbox.push(m);
  });
  const next = (pred: (m: ServerMessage) => boolean = () => true) =>
    new Promise<ServerMessage>((resolve) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) resolve(inbox.splice(i, 1)[0]!);
      else waiters.push({ pred, resolve });
    });
  const challenge = (await next((m) => m.t === 'challenge')) as { nonce: string };
  const keys = await generateIdentityKeyPair();
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  ws.send(JSON.stringify(await buildAuthMessage({ secret: SECRET, nonce: challenge.nonce, publicKeyRaw, privateKey: keys.privateKey, name })));
  const welcome = (await next((m) => m.t === 'welcome')) as { you: Person };
  return { ws, you: welcome.you, inbox, next };
}

const names = (m: ServerMessage) => (m as { people: Person[] }).people.map((p) => p.name).sort();

describe('presence', () => {
  it('welcomes as a visitor and broadcasts a full snapshot on every join and leave', async () => {
    const a = await attach('Alice');
    expect(a.you).toMatchObject({ name: 'Alice', role: 'visitor', joinSeq: null, sharing: false, muted: false });
    expect(names(await a.next((m) => m.t === 'presence'))).toContain('Alice');

    const b = await attach('Bob');
    expect(names(await a.next((m) => m.t === 'presence'))).toEqual(['Alice', 'Bob']);
    expect(names(await b.next((m) => m.t === 'presence'))).toEqual(['Alice', 'Bob']);

    b.ws.close(1000, 'bye');
    const afterLeave = names(await a.next((m) => m.t === 'presence'));
    expect(afterLeave).toContain('Alice');
    expect(afterLeave).not.toContain('Bob');
    a.ws.close(1000, 'bye');
  });

  it('survives eviction: a brand-new Room instance over the same state sees the same presence', async () => {
    const a = await attach('Alice');
    const seenByClient = names(await a.next((m) => m.t === 'presence'));
    const stub = env.ROOM.get(env.ROOM.idFromName('the-room'));
    const { ownKeys, fromLiveInstance, fromFreshInstance } = await runInDurableObject(stub, (instance: Room, state) => {
      // Eviction destroys the instance and re-creates it from (state, env). Simulate exactly that.
      const fresh = new Room(state, env);
      return {
        ownKeys: Object.keys(instance).filter((k) => k !== 'ctx' && k !== 'env'),
        fromLiveInstance: names(instance.currentPresence()),
        fromFreshInstance: names(fresh.currentPresence()),
      };
    });
    expect(ownKeys).toEqual([]);
    expect(fromFreshInstance).toEqual(fromLiveInstance);
    expect(fromFreshInstance).toEqual(expect.arrayContaining(seenByClient));
    a.ws.close(1000, 'bye');
  });
});

describe('text', () => {
  it('relays text to everyone, tagged by the server with the sender identity', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    b.ws.send(JSON.stringify({ t: 'text', text: '  hello all  ' }));
    const seenByA = (await a.next((m) => m.t === 'text')) as unknown as { from: Person; text: string; at: number };
    const seenByB = (await b.next((m) => m.t === 'text')) as unknown as { from: Person; text: string };
    expect(seenByA.text).toBe('hello all');
    expect(seenByA.from).toEqual({ publicKey: b.you.publicKey, fingerprint: b.you.fingerprint, name: 'Bob' });
    expect(typeof seenByA.at).toBe('number');
    expect(seenByB.from.name).toBe('Bob');
    a.ws.close(1000, 'bye');
    b.ws.close(1000, 'bye');
  });

  it('rejects empty and over-long text', async () => {
    const a = await attach('Alice');
    a.ws.send(JSON.stringify({ t: 'text', text: '   ' }));
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'empty message' });
    a.ws.send(JSON.stringify({ t: 'text', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }));
    expect((await a.next((m) => m.t === 'error')) as { reason: string }).toMatchObject({ reason: expect.stringContaining('longer than') });
    a.ws.close(1000, 'bye');
  });

  it('relays the burst and drops the excess with a rate-limited error', async () => {
    const a = await attach('Alice');
    const extra = 5;
    for (let i = 0; i < BURST + extra; i++) a.ws.send(JSON.stringify({ t: 'text', text: `m${i}` }));
    const err = await a.next((m) => m.t === 'error');
    expect(err).toEqual({ t: 'error', reason: 'rate limited', ref: 'text' });
    await new Promise((r) => setTimeout(r, 100));
    const relayed = a.inbox.filter((m) => m.t === 'text').length;
    const errors = a.inbox.filter((m) => m.t === 'error').length + 1;
    expect(relayed).toBeGreaterThanOrEqual(BURST); // the burst went through (refill may let a few more pass)
    expect(relayed + errors).toBe(BURST + extra); // nothing vanished silently
    a.ws.close(1000, 'bye');
  });

  it('names the reason for an over-long message', async () => {
    const a = await attach('Alice');
    a.ws.send(JSON.stringify({ t: 'text', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }));
    expect((await a.next((m) => m.t === 'error')) as { reason: string }).toMatchObject({ reason: `message longer than ${MAX_TEXT_LENGTH} characters` });
    a.ws.close(1000, 'bye');
  });
});

describe('ping', () => {
  it('answers the exact ping frame at the edge, recorded by the auto-response timestamp', async () => {
    const a = await attach('Alice');
    a.ws.send(PING_FRAME);
    const pong = await a.next((m) => m.t === 'pong');
    expect(JSON.stringify(pong)).toBe(PONG_FRAME);
    const stub = env.ROOM.get(env.ROOM.idFromName('the-room'));
    const stamped = await runInDurableObject(stub, (_i, state) =>
      state.getWebSockets().some((s) => state.getWebSocketAutoResponseTimestamp(s) !== null));
    expect(stamped).toBe(true); // the platform answered; a woken webSocketMessage would not set this
    a.ws.close(1000, 'bye');
  });
});
