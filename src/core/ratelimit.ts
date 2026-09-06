// Token bucket kept as plain data in the socket attachment (spec §4: 20 messages
// per second per socket, burst 40). Pure function of (bucket, now).

export type Bucket = { tokens: number; at: number };

export const RATE_PER_SECOND = 20;
export const BURST = 40;

/**
 * Signaling (offers, answers, ICE candidates) legitimately bursts: a join against a TURN provider with
 * six URLs yields dozens of candidates per peer within a second. Throttling those stalls ICE for tens
 * of seconds (observed live), so signaling has its own, generous bucket.
 */
export const SIGNAL_RATE_PER_SECOND = 100;
export const SIGNAL_BURST = 400;

export function newBucket(now: number, burst = BURST): Bucket {
  return { tokens: burst, at: now };
}

/** Refill by elapsed time, then try to take one token. Returns the new bucket and whether the message may pass. */
export function takeToken(bucket: Bucket, now: number, rate = RATE_PER_SECOND, burst = BURST): { bucket: Bucket; ok: boolean } {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  const tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  if (tokens < 1) return { bucket: { tokens, at: now }, ok: false };
  return { bucket: { tokens: tokens - 1, at: now }, ok: true };
}
