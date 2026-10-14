import { describe, expect, it } from 'vitest';
import { beat, heard, heartbeat } from '../src/core/heartbeat';
import { PING_INTERVAL_MS } from '../src/core/protocol';

const ticks = (h: ReturnType<typeof heartbeat>, times: number[]) => times.map((t) => beat(h, t));

describe('heartbeat (quality ticket 10)', () => {
  it('pings while the Room answers', () => {
    const h = heartbeat(0);
    for (let t = PING_INTERVAL_MS; t <= 10 * PING_INTERVAL_MS; t += PING_INTERVAL_MS) {
      expect(beat(h, t)).toBe('ping');
      heard(h);
    }
  });

  it('gives a socket up at the tick after two unanswered pings, a minute after the first', () => {
    const h = heartbeat(0);
    expect(ticks(h, [30_000, 60_000, 90_000])).toEqual(['ping', 'ping', 'dead']);
    expect(h.since).toBe(30_000);
  });

  it('counts any frame as an answer', () => {
    const h = heartbeat(0);
    expect(ticks(h, [30_000, 60_000])).toEqual(['ping', 'ping']);
    heard(h);
    expect(ticks(h, [90_000, 120_000])).toEqual(['ping', 'ping']);
    expect(beat(h, 150_000)).toBe('dead');
  });

  it('takes a hidden tab, whose timer runs once a minute, as on time', () => {
    const h = heartbeat(0);
    expect(ticks(h, [60_000, 120_000, 180_000])).toEqual(['ping', 'ping', 'dead']);
  });

  it('never gives a socket up on the first tick after a freeze: an answer may wait behind it', () => {
    const h = heartbeat(0);
    expect(ticks(h, [30_000, 60_000])).toEqual(['ping', 'ping']);
    // Frozen for five minutes: the tick comes late, and pings once more.
    expect(beat(h, 360_000)).toBe('ping');
    heard(h); // the answer, queued behind the tick
    expect(beat(h, 390_000)).toBe('ping');
  });

  it('gives it up a tick later if the freeze took the socket with it', () => {
    const h = heartbeat(0);
    expect(ticks(h, [30_000, 360_000, 390_000])).toEqual(['ping', 'ping', 'dead']);
  });
});
