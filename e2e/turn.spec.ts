// A deployed copy hands out TURN, to file links and to calls alike. Report of 2026-10-16 on PR #68's preview: a phone's
// pictures never came, both sides of the link had host and srflx candidates only and `turn: false`. preview.yml put the
// TURN token on a Worker named `dave-preview`, from wrangler.jsonc, and deployed `dave-pr-<n>` without it: no preview had
// TURN, and a friend behind a strict NAT could neither pull a file nor call there.
import { expect, newSecret, test } from './fixtures';
import { originFor, target, type Engine } from './browsers';
import { authKeyOf, roomIdOf } from '../src/core/rooms';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair } from '../src/core/identity';

type Ice = Array<{ urls: string | string[] }>;
const hasTurn = (servers: Ice) => servers.some((s) => [s.urls].flat().some((u) => u.startsWith('turn')));

/** Enters a fresh room from Node, as the app does, and asks for a file link's ICE servers, then for a call's. */
async function askRoom(origin: string): Promise<{ link: Ice; call: Ice }> {
  const secret = newSecret();
  const [roomId, authKey, keys] = await Promise.all([roomIdOf(secret), authKeyOf(secret), generateIdentityKeyPair()]);
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws/${roomId}`);
  try {
    return await new Promise((resolve, reject) => {
      let link: Ice = [];
      ws.onerror = () => reject(new Error('socket failed'));
      ws.onmessage = async (e) => {
        const m = JSON.parse(String(e.data)) as { t: string; nonce?: string; fresh?: boolean; iceServers?: Ice; reason?: string };
        if (m.t === 'challenge') {
          const auth = await buildAuthMessage({ authKey, nonce: m.nonce!, publicKeyRaw, privateKey: keys.privateKey, name: 'Probe' });
          ws.send(JSON.stringify({ ...auth, ...(m.fresh ? { authKey } : {}) }));
        } else if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'linkice', id: 1 }));
        else if (m.t === 'linkice') { link = m.iceServers!; ws.send(JSON.stringify({ t: 'join', muted: true, id: 2 })); }
        else if (m.t === 'call') { ws.send('{"t":"leave"}'); resolve({ link, call: m.iceServers! }); }
        else if (m.t === 'error') reject(new Error(m.reason));
      };
    });
  } finally {
    ws.close();
  }
}

test('a deployed copy hands out TURN to file links and to calls', async ({ browserName }) => {
  test.skip(!target, 'a local build has no TURN token');
  const { link, call } = await askRoom(originFor(browserName as Engine));
  expect(hasTurn(link), `file link ICE servers: ${JSON.stringify(link)}`).toBe(true);
  expect(hasTurn(call), `call ICE servers: ${JSON.stringify(call)}`).toBe(true);
});
