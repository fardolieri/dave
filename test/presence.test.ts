import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { MAX_TEXT_LENGTH, PING_FRAME, PONG_FRAME, type Person, type ServerMessage } from '../src/core/protocol';
import { BURST } from '../src/core/ratelimit';

const SECRET = 'test-secret';

type Client = { ws: WebSocket; you: Person; inbox: ServerMessage[]; next: (pred?: (m: ServerMessage) => boolean) => Promise<ServerMessage> };

/** Opens, authenticates, and returns a client whose inbox records everything after the welcome. */
async function join(name: string): Promise<Client> {
  const res = await exports.default.fetch(new Request('https://dave.test/ws', { headers: { Upgrade: 'websocket' } }));
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
    const a = await join('Alice');
    expect(a.you).toMatchObject({ name: 'Alice', role: 'visitor', joinSeq: null, sharing: false, muted: false });
    expect(names(await a.next((m) => m.t === 'presence'))).toEqual(['Alice']);

    const b = await join('Bob');
    expect(names(await a.next((m) => m.t === 'presence'))).toEqual(['Alice', 'Bob']);
    expect(names(await b.next((m) => m.t === 'presence'))).toEqual(['Alice', 'Bob']);

    b.ws.close(1000, 'bye');
    const afterLeave = names(await a.next((m) => m.t === 'presence'));
    expect(afterLeave).toContain('Alice');
    expect(afterLeave).not.toContain('Bob');
    a.ws.close(1000, 'bye');
  });

  it('keeps no state in the Room instance: presence is rebuilt from attachments alone', async () => {
    const a = await join('Alice');
    await a.next((m) => m.t === 'presence');
    const stub = env.ROOM.get(env.ROOM.idFromName('the-room'));
    const { ownKeys, fromAttachments } = await runInDurableObject(stub, (instance: object, state) => {
      const sockets = state.getWebSockets();
      return {
        ownKeys: Object.keys(instance).filter((k) => k !== 'ctx' && k !== 'env'),
        fromAttachments: sockets.map((s) => (s.deserializeAttachment() as { person?: Person }).person?.name).filter(Boolean),
      };
    });
    expect(ownKeys).toEqual([]);
    expect(fromAttachments).toContain('Alice'); // sockets from earlier tests may still be draining
    a.ws.close(1000, 'bye');
  });
});

describe('text', () => {
  it('relays text to everyone, tagged by the server with the sender identity', async () => {
    const a = await join('Alice');
    const b = await join('Bob');
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
    const a = await join('Alice');
    a.ws.send(JSON.stringify({ t: 'text', text: '   ' }));
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'unrecognised message' });
    a.ws.send(JSON.stringify({ t: 'text', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }));
    expect(await a.next((m) => m.t === 'error')).toEqual({ t: 'error', reason: 'unrecognised message' });
    a.ws.close(1000, 'bye');
  });

  it('drops messages beyond the burst with a rate-limited error', async () => {
    const a = await join('Alice');
    for (let i = 0; i < BURST + 5; i++) a.ws.send(JSON.stringify({ t: 'text', text: `m${i}` }));
    const err = await a.next((m) => m.t === 'error');
    expect(err).toEqual({ t: 'error', reason: 'rate limited' });
    a.ws.close(1000, 'bye');
  });
});

describe('ping', () => {
  it('answers the exact ping frame with the exact pong frame', async () => {
    const a = await join('Alice');
    a.ws.send(PING_FRAME);
    const pong = await a.next((m) => m.t === 'pong');
    expect(JSON.stringify(pong)).toBe(PONG_FRAME);
    a.ws.close(1000, 'bye');
  });
});
