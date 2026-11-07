// Private conversations as rooms of two (ADR 0011), the parts that are plain data. Runtime-neutral.
import { isPublicKeyText } from './protocol';

/**
 * A friend's private text key as this browser last saw it published, signed by their identity, and checked (ADR 0007):
 * what the room of two with them is derived from (core/sealed.ts, `pairSecret`), so it is kept, to reach them while they
 * are online in none of my rooms. `fingerprint`: theirs, to show them by in that room, where they go by another key.
 */
export type PairKey = { key: string; sig: string; fingerprint: string };

/** `pairKeys` as read from localStorage: friend key to PairKey; anything else is left out. */
export function parsePairKeys(raw: string | null): Record<string, PairKey> {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, PairKey> = {};
  for (const [friend, k] of Object.entries(v as Record<string, unknown>)) {
    const p = k as Partial<PairKey> | null;
    if (!isPublicKeyText(friend) || !p || typeof p !== 'object' || typeof p.key !== 'string' || typeof p.sig !== 'string' || typeof p.fingerprint !== 'string') continue;
    out[friend] = { key: p.key, sig: p.sig, fingerprint: p.fingerprint };
  }
  return out;
}
