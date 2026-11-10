import { describe, expect, it } from 'vitest';
import { beat, heard, heartbeat, probe, probed, PROBE_TIMEOUT_MS } from '../src/core/heartbeat';
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

describe('probe (ticket 78)', () => {
  it('gives a socket up when the probe goes unanswered past its deadline', () => {
    const h = heartbeat(0);
    expect(probe(h, 1_000)).toBe(true);
    expect(probed(h, 1_000 + PROBE_TIMEOUT_MS)).toBe('dead');
  });

  it('counts any frame as the answer', () => {
    const h = heartbeat(0);
    probe(h, 1_000);
    heard(h);
    expect(probed(h, 1_000 + PROBE_TIMEOUT_MS)).toBe('alive');
  });

  it('sends one probe at a time: a second ask while one waits sends nothing', () => {
    const h = heartbeat(0);
    expect(probe(h, 1_000)).toBe(true);
    expect(probe(h, 2_000)).toBe(false);
    heard(h);
    expect(probe(h, 3_000)).toBe(true);
  });

  it('probes again, not gives up, when the deadline comes late: the page was frozen and an answer may wait behind it', () => {
    const h = heartbeat(0);
    probe(h, 1_000);
    expect(probed(h, 60_000)).toBe('again');
    expect(probed(h, 60_000 + PROBE_TIMEOUT_MS)).toBe('dead');
  });

  it('waits while the socket is busy, and starts the deadline again from the last time it was', () => {
    const h = heartbeat(0);
    probe(h, 1_000);
    expect(probed(h, 6_000, true)).toBe('wait');
    expect(probed(h, 11_000, true)).toBe('wait');
    // The queue went out after the last look: the deadline runs from that look, not from the ping.
    expect(probed(h, 16_000)).toBe('dead');
  });

  it('takes the answer to what kept the socket busy as the probe\'s', () => {
    const h = heartbeat(0);
    probe(h, 1_000);
    expect(probed(h, 6_000, true)).toBe('wait');
    heard(h); // the Room keeps the last piece
    expect(probed(h, 11_000)).toBe('alive');
  });

  it('leaves the heartbeat to itself', () => {
    const h = heartbeat(0);
    probe(h, 1_000);
    expect(ticks(h, [30_000, 60_000, 90_000])).toEqual(['ping', 'ping', 'dead']);
  });
});
