// Diagnostic, not for master (ticket 54, ticket 57): where is a let-in socket cut with 1006 "from below", mostly within a
// second or two of another socket of the room connecting? Three observers sit in one room while Bob comes in again and
// again (a reload: his socket closes, a new one is let in), and each counts its own drops:
// - `proxy`: Alice, a friend as every test has her, her socket through Playwright's routeWebSocket (the Wire);
// - `page`: Dora, the app in a context without routeWebSocket, her sockets watched from inside the page;
// - `node`: a socket from the test's own Node process, no browser at all, authenticated by hand.
// A drop seen by `proxy` alone is the proxy's; by `proxy` and `page` but never `node`, the browsers'; by all three, the
// edge's or the Room's. Each drop is printed with how long after Bob's last welcome it came.
import { expect, test } from './fixtures';
import { originFor, type Engine } from './browsers';
import { authKeyOf, roomIdOf } from '../src/core/rooms';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair } from '../src/core/identity';

const ROUNDS = Number(process.env['DIAG_ROUNDS'] ?? 60);
type Drop = { who: string; code: number; at: number };

/** A socket from Node: answers the challenge as the app does, pings like it, and records every close. */
async function nodeObserver(origin: string, secret: string, drops: Drop[]): Promise<{ stop: () => void; welcomed: () => number }> {
  const roomId = await roomIdOf(secret);
  const authKey = await authKeyOf(secret);
  const keys = await generateIdentityKeyPair();
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  const url = `${origin.replace(/^http/, 'ws')}/ws/${roomId}`;
  let stopped = false;
  let welcomes = 0;
  let ping: ReturnType<typeof setInterval> | undefined;
  const open = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.onmessage = async (e) => {
      const m = JSON.parse(String(e.data)) as { t: string; nonce?: string; fresh?: boolean };
      if (m.t === 'challenge') {
        const auth = await buildAuthMessage({ authKey, nonce: m.nonce!, publicKeyRaw, privateKey: keys.privateKey, name: 'Nodo' });
        ws.send(JSON.stringify({ ...auth, ...(m.fresh ? { authKey } : {}) }));
      } else if (m.t === 'welcome') welcomes++;
    };
    ws.onopen = () => { ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), 30_000); };
    ws.onclose = (e) => { clearInterval(ping); if (!stopped) { drops.push({ who: 'node', code: e.code, at: Date.now() }); setTimeout(open, 1000); } };
  };
  open();
  return { stop: () => { stopped = true; clearInterval(ping); }, welcomed: () => welcomes };
}

test('diag: which observers lose their socket while another friend keeps coming in', async ({ crowd, browser, browserName }) => {
  test.skip(!process.env['E2E_GREP']?.includes('diag'), 'diagnostic: only when asked for by name');
  test.setTimeout(ROUNDS * 6_000 + 120_000);
  const origin = originFor(browserName as Engine);
  const drops: Drop[] = [];
  const node = await nodeObserver(origin, crowd.room.secret, drops);
  const alice = await crowd.open('Alice');

  // Dora: the app without the Wire. Every socket the page opens reports its close code to the test.
  const dora = await browser.newContext({ baseURL: origin });
  await dora.route(/posthog\.com|\/diag\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await dora.exposeFunction('diagClose', (code: number) => drops.push({ who: 'page', code, at: Date.now() }));
  await dora.addInitScript((seed) => {
    localStorage.setItem('dave.test', 'true');
    localStorage.setItem('dave.name', 'Dora');
    localStorage.setItem('dave.telemetry', 'off');
    localStorage.setItem('dave.rooms', JSON.stringify([{ ...seed, addedAt: Date.now() }]));
    localStorage.setItem('dave.room', seed.secret);
    const Native = WebSocket;
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('close', (e) => (window as unknown as { diagClose: (c: number) => void }).diagClose(e.code));
      }
    };
  }, crowd.room);
  const doraPage = await dora.newPage();
  await doraPage.goto('/');
  await expect(doraPage.locator('.chat-field > input')).toBeEnabled();

  const bob = await crowd.open('Bob');
  const welcomes: number[] = [];
  const reloads: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    reloads.push(Date.now());
    await bob.page.reload();
    await bob.connected();
    welcomes.push(Date.now());
  }
  await expect.poll(() => alice.online()).toContain('Bob');

  for (const c of alice.wire.closes) if (c.side === 'server') drops.push({ who: 'proxy', code: c.code ?? 0, at: c.at });
  node.stop();
  await dora.close();
  const since = (list: number[], at: number) => { const w = list.filter((x) => x <= at).at(-1); return w === undefined ? null : at - w; };
  const report = {
    engine: browserName, target: origin, rounds: ROUNDS, nodeWelcomes: node.welcomed(), aliceSockets: alice.wire.closes.length + alice.wire.open,
    drops: drops.map((d) => ({ ...d, sinceBobReload: since(reloads, d.at), sinceBobConnected: since(welcomes, d.at) })),
  };
  console.log(`DIAG ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'diag', description: JSON.stringify(report) });
});
