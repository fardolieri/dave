// Token bucket kept as plain data in the socket attachment (spec §4: 20 messages
// per second per socket, burst 40). Pure function of (bucket, now).

export type Bucket = { tokens: number; at: number };

export const RATE_PER_SECOND = 20;
export const BURST = 40;

export function newBucket(now: number): Bucket {
  return { tokens: BURST, at: now };
}

/** Refill by elapsed time, then try to take one token. Returns the new bucket and whether the message may pass. */
export function takeToken(bucket: Bucket, now: number): { bucket: Bucket; ok: boolean } {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  const tokens = Math.min(BURST, bucket.tokens + elapsed * RATE_PER_SECOND);
  if (tokens < 1) return { bucket: { tokens, at: now }, ok: false };
  return { bucket: { tokens: tokens - 1, at: now }, ok: true };
}
