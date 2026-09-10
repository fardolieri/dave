import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair } from '../src/core/identity';
import type { IceServer, Person, ServerMessage } from '../src/core/protocol';
import { CLOSE_SILENT, SILENT_TIMEOUT_MS } from '../src/worker/room';
import { CLOSE_SUPERSEDED } from '../src/core/protocol';

const SECRET = 'test-secret';
type Client = { ws: WebSocket; you: Person; next: (pred?: (m: ServerMessage) => boolean) => Promise<ServerMessage>; closed: Promise<number> };

type Keys = Awaited<ReturnType<typeof generateIdentityKeyPair>>;
async function attach(name: string, existingKeys?: Keys): Promise<Client> {
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
  const challenge = (await next((m) => m.t === 'challenge')) as { nonce: string };
  const keys = existingKeys ?? await generateIdentityKeyPair();
  ws.send(JSON.stringify(await buildAuthMessage({ secret: SECRET, nonce: challenge.nonce, publicKeyRaw: await exportPublicKey(keys.publicKey), privateKey: keys.privateKey, name })));
  const welcome = (await next((m) => m.t === 'welcome')) as { you: Person };
  return { ws, you: welcome.you, next, closed };
}

const send = (c: Client, m: object) => c.ws.send(JSON.stringify(m));
const inCall = (m: ServerMessage) => (m as { people: Person[] }).people.filter((p) => p.role === 'participant');

describe('joining and leaving the call', () => {
  it('assigns increasing join sequences derived from presence and returns ICE servers', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    send(a, { t: 'join', muted: false });
    const callA = (await a.next((m) => m.t === 'call')) as { joinSeq: number; iceServers: IceServer[]; issuedAt: number };
    send(b, { t: 'join', muted: true });
    const callB = (await b.next((m) => m.t === 'call')) as { joinSeq: number };
    expect(callB.joinSeq).toBeGreaterThan(callA.joinSeq);
    expect(callA.iceServers.some((s) => String(s.urls).startsWith('stun:'))).toBe(true); // STUN fallback without a TURN token
    expect(typeof callA.issuedAt).toBe('number');
    const snap = await a.next((m) => m.t === 'presence' && inCall(m).length === 2);
    expect(inCall(snap).map((p) => [p.name, p.muted])).toEqual(expect.arrayContaining([['Alice', false], ['Bob', true]]));
    a.ws.close(1000); b.ws.close(1000);
  });

  it('a deliberate leave broadcasts "left" and the person becomes a visitor again', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(b, { t: 'join', muted: false }); await b.next((m) => m.t === 'call');
    send(b, { t: 'leave' });
    expect(await a.next((m) => m.t === 'left')).toEqual({ t: 'left', publicKey: b.you.publicKey });
    const people = (m: ServerMessage) => (m as { people: Person[] }).people;
    const snap = await a.next((m) => m.t === 'presence' && people(m).some((p) => p.name === 'Bob' && p.role === 'visitor') && people(m).some((p) => p.name === 'Alice' && p.role === 'participant'));
    expect(inCall(snap).map((p) => p.name)).toEqual(['Alice']);
    a.ws.close(1000); b.ws.close(1000);
  });

  it('mute changes propagate through presence, nothing else', async () => {
    const a = await attach('Alice');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(a, { t: 'mute', muted: true });
    const snap = await a.next((m) => m.t === 'presence' && inCall(m).some((p) => p.name === 'Alice' && p.muted));
    expect(inCall(snap).find((p) => p.name === 'Alice')!.muted).toBe(true);
    a.ws.close(1000);
  });

  it('visitors cannot signal or fetch ICE', async () => {
    const a = await attach('Alice');
    send(a, { t: 'ice' });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'not in the call', ref: 'ice' });
    a.ws.close(1000);
  });
});

describe('signaling relay', () => {
  it('relays point to point between participants only, tagged with the sender key', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    const v = await attach('Visitor');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(b, { t: 'join', muted: false }); await b.next((m) => m.t === 'call');
    send(a, { t: 'signal', to: b.you.publicKey, data: { description: { type: 'offer', sdp: 'v=0' } } });
    const got = await b.next((m) => m.t === 'signal');
    expect(got).toEqual({ t: 'signal', from: a.you.publicKey, data: { description: { type: 'offer', sdp: 'v=0' } } });
    // the identity signature over the DTLS fingerprints (ADR 0004) passes through untouched; a malformed one is rejected
    send(a, { t: 'signal', to: b.you.publicKey, data: { description: { type: 'answer', sdp: 'v=0' }, sig: 'c2ln' } });
    expect(await b.next((m) => m.t === 'signal')).toEqual({ t: 'signal', from: a.you.publicKey, data: { description: { type: 'answer', sdp: 'v=0' }, sig: 'c2ln' } });
    send(a, { t: 'signal', to: b.you.publicKey, data: { description: { type: 'answer', sdp: 'v=0' }, sig: 'not base64!' } });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'unrecognised message' });
    send(a, { t: 'signal', to: b.you.publicKey, data: { candidates: [{ candidate: 'x' }, null] } });
    expect(await b.next((m) => m.t === 'signal')).toEqual({ t: 'signal', from: a.you.publicKey, data: { candidates: [{ candidate: 'x' }, null] } });
    send(a, { t: 'signal', to: v.you.publicKey, data: { candidates: [null] } });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'that participant is not in the call', ref: 'signal' });
    send(v, { t: 'signal', to: a.you.publicKey, data: { candidates: [null] } });
    expect(await v.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'not in the call', ref: 'signal' });
    a.ws.close(1000); b.ws.close(1000); v.ws.close(1000);
  });
});

describe('sweep', () => {
  it('leaves recently attached sockets alone', async () => {
    const a = await attach('Alice');
    await a.next((m) => m.t === 'presence');
    const stub = env.ROOM.get(env.ROOM.idFromName('the-room'));
    expect(await runDurableObjectAlarm(stub)).toBe(true); // an alarm is always pending while sockets exist
    a.ws.send('{"t":"ping"}');
    expect((await a.next((m) => m.t === 'pong')).t).toBe('pong'); // still open
    a.ws.close(1000);
  });

  it('drops sockets with no sign of life for 90 s with a dedicated close code', async () => {
    const a = await attach('Alice');
    await a.next((m) => m.t === 'presence');
    // The platform stamps pings with real time; the sweep compares against Date.now(), which we advance.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + SILENT_TIMEOUT_MS + 1000);
      const stub = env.ROOM.get(env.ROOM.idFromName('the-room'));
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(await a.closed).toBe(CLOSE_SILENT);
  });
});

describe('one socket per identity', () => {
  it('a newer socket for the same identity closes the older one with 4004 and presence lists the person once', async () => {
    const keys = await generateIdentityKeyPair();
    const bob = await attach('Bob');
    const a1 = await attach('Alice', keys);
    send(a1, { t: 'join', muted: false }); await a1.next((m) => m.t === 'call');
    await bob.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.role === 'participant'));
    const a2 = await attach('Alice', keys); // e.g. a reconnect whose old socket the server never saw die
    expect(await a1.closed).toBe(CLOSE_SUPERSEDED);
    const snap = await bob.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.filter((p) => p.name === 'Alice').length === 1 && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.role === 'visitor'));
    expect((snap as { people: Person[] }).people.filter((p) => p.name === 'Alice')).toHaveLength(1);
    // the survivor is fully functional: it joins and gets signalled
    send(a2, { t: 'join', muted: false }); await a2.next((m) => m.t === 'call');
    send(bob, { t: 'join', muted: false }); await bob.next((m) => m.t === 'call');
    send(bob, { t: 'signal', to: a2.you.publicKey, data: { description: { type: 'offer', sdp: 'x' } } });
    expect(await a2.next((m) => m.t === 'signal')).toMatchObject({ t: 'signal', from: bob.you.publicKey });
    a2.ws.close(1000); bob.ws.close(1000);
  });
});

describe('shares', () => {
  it('share on/off travels through the presence flag and subscribe is relayed to the sharer', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(b, { t: 'join', muted: false }); await b.next((m) => m.t === 'call');
    send(a, { t: 'share', on: true });
    const snap = await b.next((m) => m.t === 'presence' && inCall(m).some((p) => p.name === 'Alice' && p.sharing));
    expect(inCall(snap).find((p) => p.name === 'Alice')!.sharing).toBe(true);
    send(b, { t: 'subscribe', to: a.you.publicKey, on: true, scale: 2 });
    expect(await a.next((m) => m.t === 'subscribe')).toEqual({ t: 'subscribe', from: b.you.publicKey, on: true, scale: 2 });
    send(b, { t: 'subscribe', to: a.you.publicKey, on: true, scale: 99 }); // out of range: dropped, not rejected
    expect(await a.next((m) => m.t === 'subscribe')).toEqual({ t: 'subscribe', from: b.you.publicKey, on: true });
    send(a, { t: 'share', on: false });
    await b.next((m) => m.t === 'presence' && inCall(m).some((p) => p.name === 'Alice' && !p.sharing));
    a.ws.close(1000); b.ws.close(1000);
  });

  it('a re-join can carry the sharing flag, so a share survives the sharer\'s server reconnect', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(a, { t: 'share', on: true });
    await b.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.sharing));
    send(a, { t: 'join', muted: false, sharing: true }); await a.next((m) => m.t === 'call');
    const snap = await b.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.joinSeq === 2));
    expect((snap as { people: Person[] }).people.find((p) => p.name === 'Alice')!.sharing).toBe(true);
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call'); // without the flag it resets, as before
    const snap2 = await b.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.joinSeq === 3));
    expect((snap2 as { people: Person[] }).people.find((p) => p.name === 'Alice')!.sharing).toBe(false);
    a.ws.close(1000); b.ws.close(1000);
  });

  it('leaving clears the sharing flag', async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(a, { t: 'share', on: true });
    await b.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.sharing));
    send(a, { t: 'leave' });
    const snap = await b.next((m) => m.t === 'presence' && (m as { people: Person[] }).people.some((p) => p.name === 'Alice' && p.role === 'visitor'));
    expect((snap as { people: Person[] }).people.find((p) => p.name === 'Alice')!.sharing).toBe(false);
    a.ws.close(1000); b.ws.close(1000);
  });

  it('visitors cannot share or subscribe', async () => {
    const v = await attach('Visitor');
    send(v, { t: 'share', on: true });
    expect(await v.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'not in the call', ref: 'share' });
    send(v, { t: 'subscribe', to: v.you.publicKey, on: true });
    expect(await v.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'not in the call', ref: 'subscribe' });
    v.ws.close(1000);
  });
});

describe('signaling rate limit', () => {
  it('lets a burst of a hundred signals through while text stays on the small bucket', { timeout: 20_000 }, async () => {
    const a = await attach('Alice');
    const b = await attach('Bob');
    send(a, { t: 'join', muted: false }); await a.next((m) => m.t === 'call');
    send(b, { t: 'join', muted: false }); await b.next((m) => m.t === 'call');
    const n = 100; // well past the general burst of 40; kept modest so slow CI runners finish in time
    for (let i = 0; i < n; i++) send(a, { t: 'signal', to: b.you.publicKey, data: { candidates: [{ i }] } });
    let received = 0;
    for (let i = 0; i < n; i++) { await b.next((m) => m.t === 'signal'); received++; }
    expect(received).toBe(n);
    // the general bucket is untouched by signaling: 45 texts still trip it. The clock is frozen so a slow
    // runner cannot refill the bucket while the room object works through the burst.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let i = 0; i < 45; i++) send(a, { t: 'text', text: `t${i}` });
      expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'rate limited', ref: 'text' });
    } finally {
      vi.useRealTimers();
    }
    a.ws.close(1000); b.ws.close(1000);
  });
});
