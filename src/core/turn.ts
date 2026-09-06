// Cloudflare Realtime TURN credential minting (spec §2.4), described as data so the
// adapter can perform it and tests can assert the request without a network.
import type { IceServer } from './protocol';

export const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

export type CredentialRequest = { url: string; method: 'POST'; headers: Record<string, string>; body: string };

export function turnCredentialRequest(keyId: string, apiToken: string, ttlSeconds: number): CredentialRequest {
  return {
    url: `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: ttlSeconds }),
  };
}

/** Accepts Cloudflare's `{ iceServers: [...] }` reply; anything else yields null so the caller can fall back to STUN. */
export function parseIceServers(json: unknown): IceServer[] | null {
  if (typeof json !== 'object' || json === null || !('iceServers' in json)) return null;
  const list = (json as { iceServers: unknown }).iceServers;
  if (!Array.isArray(list)) return null;
  const out: IceServer[] = [];
  for (const e of list) {
    if (typeof e !== 'object' || e === null || !('urls' in e)) return null;
    const { urls, username, credential } = e as Record<string, unknown>;
    if (typeof urls !== 'string' && !Array.isArray(urls)) return null;
    const server: IceServer = { urls: urls as string | string[] };
    if (typeof username === 'string') server.username = username;
    if (typeof credential === 'string') server.credential = credential;
    out.push(server);
  }
  return out;
}

/** UDP first: entries with `turns:` (TLS over TCP) go last so browsers try them only when needed (spec §2.4). */
export function orderIceServers(servers: IceServer[]): IceServer[] {
  const isTurns = (s: IceServer) => (Array.isArray(s.urls) ? s.urls : [s.urls]).every((u) => u.startsWith('turns:'));
  return [...servers.filter((s) => !isTurns(s)), ...servers.filter(isTurns)];
}

/** The TURN username Cloudflare minted, needed to revoke the credential on leave. */
export function turnUsername(servers: IceServer[]): string | null {
  return servers.find((s) => s.username)?.username ?? null;
}

export function turnRevokeRequest(keyId: string, apiToken: string, username: string): CredentialRequest {
  return {
    url: `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/${encodeURIComponent(username)}/revoke`,
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}` },
    body: '',
  };
}
