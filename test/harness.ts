// Shared by the worker tests: connecting to a room by its secret, the way the client does (ADR 0004).
import { exports } from 'cloudflare:workers';
import { authKeyOf, roomIdOf, textKeyOf } from '../src/core/rooms';
import { sealProfile } from '../src/core/sealed';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import type { ServerMessage } from '../src/core/protocol';

export type Keys = Awaited<ReturnType<typeof generateIdentityKeyPair>>;
export type Challenge = Extract<ServerMessage, { t: 'challenge' }>;

/** A distinct client address per socket, so the per-IP upgrade limit never trips inside a test file. */
export const randomIp = (): string => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

export const wsPath = async (secret: string): Promise<string> => `/ws/${await roomIdOf(secret)}`;

/** Opens (and accepts) a socket to the room of `secret`. */
export async function openRoomSocket(secret: string, ip = randomIp()): Promise<WebSocket> {
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
