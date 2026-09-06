import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

async function openSocket(): Promise<WebSocket> {
  const res = await exports.default.fetch(new Request('https://dave.test/ws', { headers: { Upgrade: 'websocket' } }));
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no websocket on 101 response');
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true }));
}

describe('worker', () => {
  it('serves 404 for unknown paths (assets are handled by the platform)', async () => {
    const res = await exports.default.fetch('https://dave.test/nope');
    expect(res.status).toBe(404);
  });

  it('refuses /ws without an upgrade', async () => {
    const res = await exports.default.fetch('https://dave.test/ws');
    expect(res.status).toBe(426);
  });

  it('upgrades /ws and round-trips through the Room', async () => {
    const ws = await openSocket();
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'echo', text: 'hi' }));
    expect(await reply).toEqual({ t: 'echo', text: 'hi' });
    ws.close();
  });

  it('answers ping with pong and rejects junk', async () => {
    const ws = await openSocket();
    let reply = nextMessage(ws);
    ws.send(JSON.stringify({ t: 'ping' }));
    expect(await reply).toEqual({ t: 'pong' });
    reply = nextMessage(ws);
    ws.send('not json');
    expect(await reply).toEqual({ t: 'error', reason: 'unrecognised message' });
    ws.close();
  });
});
