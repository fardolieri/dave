import { describe, expect, it } from 'vitest';
import { BURST, RATE_PER_SECOND, newBucket, takeToken } from '../src/core/ratelimit';

describe('token bucket', () => {
  it('allows a burst, then refills at the rate', () => {
    let b = newBucket(0);
    for (let i = 0; i < BURST; i++) {
      const r = takeToken(b, 0);
      expect(r.ok).toBe(true);
      b = r.bucket;
    }
    expect(takeToken(b, 0).ok).toBe(false);
    const later = takeToken(b, 1000); // one second later: RATE_PER_SECOND tokens back
    expect(later.ok).toBe(true);
    expect(later.bucket.tokens).toBeCloseTo(RATE_PER_SECOND - 1, 5);
  });
  it('never exceeds the burst after a long idle', () => {
    const b = newBucket(0);
    expect(takeToken(b, 60_000).bucket.tokens).toBe(BURST - 1);
  });
});
