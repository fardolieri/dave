import { STUN_ONLY, parseIceServers, turnCredentialRequest } from '../core/turn';
import { ICE_TTL_SECONDS } from '../core/mesh';
import type { IceServer } from '../core/protocol';

/**
 * Mint short-lived TURN credentials from Cloudflare Realtime (spec §2.4). Without a
 * usable token (local dev, tests) or on any failure, fall back to free STUN so a call
 * still works for friends who can connect directly.
 */
export async function mintIceServers(env: Env): Promise<IceServer[]> {
  const token = env.TURN_KEY_API_TOKEN;
  if (!token || token === 'unused-locally') return STUN_ONLY;
  try {
    const req = turnCredentialRequest(env.TURN_KEY_ID, token, ICE_TTL_SECONDS);
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) return STUN_ONLY;
    const servers = parseIceServers(await res.json());
    return servers ? [...STUN_ONLY, ...servers] : STUN_ONLY;
  } catch {
    return STUN_ONLY;
  }
}
