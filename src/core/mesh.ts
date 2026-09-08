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

/** Sharer upload budget split across active viewers (spec §6.4). Values in bits per second. */
export const SHARE_BUDGET_BPS = 8_000_000;
export const SHARE_CEILING_BPS = 2_500_000;
export const SHARE_FLOOR_BPS = 1_000_000;

export function perViewerBitrate(activeViewers: number, budget = SHARE_BUDGET_BPS, ceiling = SHARE_CEILING_BPS, floor = SHARE_FLOOR_BPS): number {
  if (activeViewers <= 0) return ceiling;
  return Math.max(floor, Math.min(ceiling, Math.floor(budget / activeViewers)));
}

/**
 * Stuck-connecting watchdog: a peer still "connecting" after this long is reported and rebuilt.
 * The offerer acts first; the other side a little later so both do not rebuild at once. Doubles per attempt.
 */
export const STUCK_CONNECTING_MS = 15_000;
export const STUCK_STAGGER_MS = 5_000;
export const STUCK_MAX_MS = 60_000;
export function stuckDelay(attempt: number, initiator: boolean): number {
  return Math.min(STUCK_MAX_MS, STUCK_CONNECTING_MS * 2 ** attempt) + (initiator ? 0 : STUCK_STAGGER_MS);
}
