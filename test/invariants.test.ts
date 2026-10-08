import { describe, expect, it } from 'vitest';
import { DECODING_RECENT_MS, INVARIANT_GRACE_MS, breaches, createInvariantWatch, gainFor, shareTileState, type CallFacts, type PeerFacts, type Violation } from '../src/core/invariants';

/** A friend in a healthy call: connected, not sharing, gains as their controls say. */
const peer = (o: Partial<PeerFacts> = {}): PeerFacts => ({
  key: 'bob', conn: 'direct', watching: false, shareLive: false, volume: 1, shareVolume: 1, sharing: false,
  voiceGain: 1, shareGain: 1, framesGrewAt: null, connection: 'connected', ice: 'connected', ...o,
});
const call = (peers: PeerFacts[], o: Partial<CallFacts> = {}): CallFacts => ({ at: 100_000, master: 1, micTest: false, peers, ...o });

describe('invariant rules', () => {
  it('finds nothing in a healthy call', () => {
    expect(breaches(call([peer(), peer({ key: 'carol', conn: 'relayed', sharing: true, watching: true, shareLive: true, framesGrewAt: 99_000 })]))).toEqual([]);
  });

  it('a tile on "Opening…" while its video decodes', () => {
    const opening = peer({ sharing: true, watching: true, shareLive: false, framesGrewAt: 99_000 });
    expect(breaches(call([opening]))).toEqual([{ kind: 'share_opening', key: 'bob' }]);
    // Frames that stopped growing a while ago say nothing about now; nor does a tile that is not shown or not opening.
    expect(breaches(call([{ ...opening, framesGrewAt: 100_000 - DECODING_RECENT_MS - 1 }]))).toEqual([]);
    expect(breaches(call([{ ...opening, framesGrewAt: null }]))).toEqual([]);
    expect(breaches(call([{ ...opening, sharing: false }]))).toEqual([]);
    expect(breaches(call([{ ...opening, shareLive: true }]))).toEqual([]);
    expect(breaches(call([{ ...opening, watching: false }]))).toEqual([]);
    expect(breaches(call([{ ...opening, conn: 'unreachable' }]))).toEqual([]);
  });

  it('a gain that differs from the controls, voice and share apart', () => {
    expect(breaches(call([peer({ volume: 0.5, voiceGain: 0.25, shareGain: 0.25 })], { master: 0.5 }))).toEqual([]);
    expect(breaches(call([peer({ volume: 0.5, voiceGain: 0.5, shareGain: 0.25 })], { master: 0.5 }))).toEqual([{ kind: 'voice_gain', key: 'bob' }]);
    // The share muted on its own tile leaves the voice alone (problem report of Oct 3): the other way round is a breach.
    expect(breaches(call([peer({ shareVolume: 0, voiceGain: 1, shareGain: 0 })]))).toEqual([]);
    expect(breaches(call([peer({ shareVolume: 0, voiceGain: 0, shareGain: 0 })]))).toEqual([{ kind: 'voice_gain', key: 'bob' }]);
    expect(breaches(call([peer({ shareVolume: 0.5, voiceGain: 1, shareGain: 1 })]))).toEqual([{ kind: 'share_gain', key: 'bob' }]);
    // A mic test silences everyone; audio not wired yet has no gain to compare.
    expect(breaches(call([peer({ voiceGain: 0, shareGain: 0 })], { micTest: true }))).toEqual([]);
    expect(breaches(call([peer({ voiceGain: 1, shareGain: 0 })], { micTest: true }))).toEqual([{ kind: 'voice_gain', key: 'bob' }]);
    expect(breaches(call([peer({ voiceGain: null, shareGain: null, volume: 0.3 })]))).toEqual([]);
  });

  it('reads gains as the 32-bit floats a gain node holds', () => {
    expect(breaches(call([peer({ volume: 0.35, voiceGain: Math.fround(0.35), shareGain: Math.fround(0.35) })]))).toEqual([]);
  });

  it('a badge saying connected over a failed or closed transport', () => {
    expect(breaches(call([peer({ connection: 'closed', ice: 'closed' })]))).toEqual([{ kind: 'conn_transport', key: 'bob' }]);
    expect(breaches(call([peer({ conn: 'relayed', connection: 'failed', ice: 'connected' })]))).toEqual([{ kind: 'conn_transport', key: 'bob' }]);
    expect(breaches(call([peer({ conn: 'unreachable', connection: 'failed', ice: 'failed' })]))).toEqual([]);
    expect(breaches(call([peer({ conn: 'reconnecting', connection: 'disconnected', ice: 'disconnected' })]))).toEqual([]);
  });

  it('the tile states', () => {
    const view = { conn: 'direct', watching: true, shareLive: false };
    expect(shareTileState(true, true, view)).toBe('own');
    expect(shareTileState(false, false, view)).toBe('locked');
    expect(shareTileState(false, true, { ...view, conn: 'unreachable' })).toBe('unreachable');
    expect(shareTileState(false, true, undefined)).toBe('closed');
    expect(shareTileState(false, true, view)).toBe('opening');
    expect(shareTileState(false, true, { ...view, shareLive: true })).toBe('live');
    expect(gainFor('share', { master: 0.5, volume: 0.5, shareVolume: 0.5, micTest: false })).toBe(0.125);
  });
});

describe('invariant watch', () => {
  const b = { kind: 'voice_gain', key: 'bob' } as const;
  const grace = INVARIANT_GRACE_MS.voice_gain;

  it('reports a breach once it has held for its grace period, once per kind per call', () => {
    const w = createInvariantWatch();
    let at = 0;
    const seen: Violation[] = [];
    for (; at <= grace; at += 2000) seen.push(...w.feed(at, [b]));
    expect(seen).toEqual([{ ...b, heldMs: grace }]);
    // Another friend with the same breach, later in the same call: already reported.
    for (let t = 0; t <= grace; t += 2000) expect(w.feed((at += 2000), [b, { ...b, key: 'carol' }])).toEqual([]);
    w.reset();
    at = 0;
    const again: Violation[] = [];
    for (; at <= grace; at += 2000) again.push(...w.feed(at, [b]));
    expect(again).toHaveLength(1);
  });

  it('starts over when a reading lacks the breach', () => {
    const w = createInvariantWatch();
    expect(w.feed(0, [b])).toEqual([]);
    expect(w.feed(2000, [b])).toEqual([]);
    expect(w.feed(4000, [])).toEqual([]);
    for (let at = 6000; at < 6000 + grace; at += 2000) expect(w.feed(at, [b])).toEqual([]);
    expect(w.feed(6000 + grace, [b])).toHaveLength(1);
  });

  it('starts over after a gap between readings: a throttled tab ran nothing that would have set things right', () => {
    const w = createInvariantWatch();
    expect(w.feed(0, [b])).toEqual([]);
    expect(w.feed(60_000, [b])).toEqual([]); // held for a minute by the clock, but read only twice
    for (let at = 62_000; at < 60_000 + grace; at += 2000) expect(w.feed(at, [b])).toEqual([]);
    expect(w.feed(60_000 + grace, [b])).toEqual([{ ...b, heldMs: grace }]);
  });

  it('follows each friend on their own', () => {
    const w = createInvariantWatch();
    expect(w.feed(0, [b])).toEqual([]);
    expect(w.feed(2000, [{ ...b, key: 'carol' }])).toEqual([]);
    expect(w.feed(4000, [b])).toEqual([]); // bob's run broke at 2000
  });
});
