// Mesh rules shared by both ends (ADR 0001). Pure functions, no imports.
import type { Person } from './protocol';

/** Fixed transceiver order on every peer connection: voice audio, share video, share audio. */
export const SLOT_INDEX = { voice: 0, shareVideo: 1, shareAudio: 2 } as const;

/** Perfect negotiation: the side whose public key compares lower is polite and rolls back on glare. Survives reconnects. */
export function isPolite(myKey: string, theirKey: string): boolean {
  return myKey < theirKey;
}

/** The newcomer (higher join sequence) creates the connection and sends the first offer. */
export function initiatesTo(me: Person, them: Person): boolean {
  return me.joinSeq !== null && them.joinSeq !== null && me.joinSeq > them.joinSeq;
}

/** Join sequences are derived from what is attached, never stored (ADR 0002). */
export function nextJoinSeq(people: Iterable<Person>): number {
  let max = 0;
  for (const p of people) if (p.joinSeq !== null && p.joinSeq > max) max = p.joinSeq;
  return max + 1;
}

/** How long a peer connection is kept after its owner vanished from presence without saying "leave" (spec §8.1). */
export const PEER_GRACE_MS = 60_000;

/** TURN credentials are minted with this TTL and refreshed when older than the refresh age. */
export const ICE_TTL_SECONDS = 12 * 3600;
export const ICE_REFRESH_AFTER_MS = 11 * 3600 * 1000;

/** ICE disconnected: wait this long before restarting ICE. Failed: restart with this backoff. */
export const ICE_DISCONNECTED_GRACE_MS = 5_000;
export const ICE_RESTART_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000] as const;
