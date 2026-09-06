import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair } from '../src/core/identity';
import type { IceServer, Person, ServerMessage } from '../src/core/protocol';
import { CLOSE_SILENT, SILENT_TIMEOUT_MS } from '../src/worker/room';

const SECRET = 'test-secret';
type Client = { ws: WebSocket; you: Person; next: (pred?: (m: ServerMessage) => boolean) => Promise<ServerMessage>; closed: Promise<number> };

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
  const keys = await generateIdentityKeyPair();
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
    send(a, { t: 'signal', to: v.you.publicKey, data: { candidate: null } });
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'that participant is not in the call', ref: 'signal' });
    send(v, { t: 'signal', to: a.you.publicKey, data: { candidate: null } });
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
