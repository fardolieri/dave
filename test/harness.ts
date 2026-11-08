// Shared by the worker tests: connecting to a room by its secret, the way the client does (ADR 0004).
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { authKeyOf, roomIdOf, textKeyOf } from '../src/core/rooms';
import { sealProfile } from '../src/core/sealed';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import type { ServerMessage } from '../src/core/protocol';

export type Keys = Awaited<ReturnType<typeof generateIdentityKeyPair>>;
export type Challenge = Extract<ServerMessage, { t: 'challenge' }>;

/** A distinct client address per socket, so the per-IP upgrade limit never trips inside a test file. */
export const randomIp = (): string => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

export const wsPath = async (secret: string): Promise<string> => `/ws/${await roomIdOf(secret)}`;

/** The rooms this test file opened sockets to, so its end can wait for what they still hand to the Store. */
const opened = new Set<string>();

/**
 * Waits until no room this file opened still has a keep, a piece or a forget on its way to the Store (worker/room.ts,
 * `keeping`). A room hands those over in `waitUntil`, after the frame is answered: a file that ends right after sending
 * texts would otherwise be torn down in the middle of one, which vitest reports as an unhandled error (ticket 73). A text
 * the room has not read yet is a keep to come, which this cannot see: a test waits for an answer that comes after it.
 * Called after every file (test/setup.ts).
 */
export async function keepsSettled(): Promise<void> {
  for (const roomId of opened) {
    await runInDurableObject(env.ROOM.get(env.ROOM.idFromName(roomId)), async (room) => {
      const r = room as unknown as { keeping: Promise<void>; pieceKeeps: Set<Promise<unknown>> };
      for (;;) {
        const keeping = r.keeping;
        await Promise.allSettled([keeping, ...r.pieceKeeps]);
        if (r.keeping === keeping && r.pieceKeeps.size === 0) return;
      }
    });
  }
}

/** Opens (and accepts) a socket to the room of `secret`. */
export async function openRoomSocket(secret: string, ip = randomIp()): Promise<WebSocket> {
  opened.add(await roomIdOf(secret));
  const res = await exports.default.fetch(new Request(`https://dave.test${await wsPath(secret)}`, { headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip } }));
  if (res.status !== 101) throw new Error(`expected 101, got ${res.status}`);
  const ws = res.webSocket;
  if (!ws) throw new Error('no websocket on 101 response');
  ws.accept();
  return ws;
}

/** The names in the profiles sealed here, by sealed text: the server lists what it cannot read, and tests read it here. */
const sealedNames = new Map<string, { name: string; picture?: string }>();
/** The name in a profile `sealProfileFor` sealed; '?' for one it did not. */
export const nameOf = (profile: string): string => sealedNames.get(profile)?.name ?? '?';
export const pictureOf = (profile: string): string | undefined => sealedNames.get(profile)?.picture;

/** A profile sealed as the client seals it (ADR 0010), with the room's text key. */
export async function sealProfileFor(keys: Keys, secret: string, name: string, picture?: string): Promise<string> {
  const sealed = await sealProfile({
    key: await textKeyOf(secret), privateKey: keys.privateKey, roomId: await roomIdOf(secret),
    from: toBase64Url(await exportPublicKey(keys.publicKey)), profile: { name, ...(picture ? { picture } : {}) },
  });
  sealedNames.set(sealed, { name, ...(picture ? { picture } : {}) });
  return sealed;
}

/** The auth frame for a challenge: the room's auth key rides along when the room is fresh, as the client does. */
export async function authFrame(challenge: Challenge, keys: Keys, secret: string, name: string, picture?: string): Promise<Record<string, unknown>> {
  const authKey = await authKeyOf(secret);
  const auth = await buildAuthMessage({ authKey, nonce: challenge.nonce, publicKeyRaw: await exportPublicKey(keys.publicKey), privateKey: keys.privateKey, profile: await sealProfileFor(keys, secret, name, picture) });
  return challenge.fresh ? { ...auth, authKey } : auth;
}
