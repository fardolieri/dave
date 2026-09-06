import { STUN_ONLY, orderIceServers, parseIceServers, turnCredentialRequest, turnRevokeRequest, turnUsername } from '../core/turn';
import { ICE_TTL_SECONDS } from '../core/mesh';
import type { IceServer } from '../core/protocol';

/**
 * Mint short-lived TURN credentials from Cloudflare Realtime (spec §2.4). Without a
 * usable token (local dev, tests) or on any failure, fall back to free STUN so a call
 * still works for friends who can connect directly.
 */
export type Minted = { iceServers: IceServer[]; turnUser: string | null };
const stunOnly: Minted = { iceServers: STUN_ONLY, turnUser: null };

// `.dev.vars.example` sets the placeholder `unused-locally`, which means: no TURN in local dev.
const usable = (env: Env): string | null => (env.TURN_KEY_API_TOKEN && env.TURN_KEY_API_TOKEN !== 'unused-locally' ? env.TURN_KEY_API_TOKEN : null);

export async function mintIceServers(env: Env): Promise<Minted> {
  const token = usable(env);
  if (!token) return stunOnly;
  try {
    const req = turnCredentialRequest(env.TURN_KEY_ID, token, ICE_TTL_SECONDS);
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return stunOnly;
    const servers = parseIceServers(await res.json());
    if (!servers) return stunOnly;
    return { iceServers: [...STUN_ONLY, ...orderIceServers(servers)], turnUser: turnUsername(servers) };
  } catch {
    return stunOnly;
  }
}

/** Revoke a minted credential when its participant leaves (spec §2.4). Best effort. */
export async function revokeIce(env: Env, username: string): Promise<void> {
  const token = usable(env);
  if (!token) return;
  try {
    const req = turnRevokeRequest(env.TURN_KEY_ID, token, username);
    await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(5000) });
  } catch {
    // credentials expire on their own after the TTL
  }
}
