// Shared by the worker tests: connecting to a room by its secret, the way the client does (ADR 0004).
import { exports } from 'cloudflare:workers';
import { authKeyOf, roomIdOf } from '../src/core/rooms';
import { buildAuthMessage, exportPublicKey, generateIdentityKeyPair } from '../src/core/identity';
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

/** The auth frame for a challenge: the room's auth key rides along when the room is fresh, as the client does. */
export async function authFrame(challenge: Challenge, keys: Keys, secret: string, name: string, picture?: string): Promise<Record<string, unknown>> {
  const authKey = await authKeyOf(secret);
  const auth = await buildAuthMessage({ authKey, nonce: challenge.nonce, publicKeyRaw: await exportPublicKey(keys.publicKey), privateKey: keys.privateKey, name, ...(picture ? { picture } : {}) });
  return challenge.fresh ? { ...auth, authKey } : auth;
}
