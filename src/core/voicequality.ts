/**
 * How a friend's voice arrives, read from the voice receiver's `inbound-rtp` counters (ticket 34). Two consumers: the
 * `voice_quality` event every 30 s, and the voice buffer that rises when the line delivers unevenly. Runtime-neutral:
 * counters in, a window or a buffer decision out.
 */

/** The cumulative counters of one stats read; every field but `at` may be missing in a browser that lacks it. */
export type VoiceCounters = {
  /** Wall clock of the read, ms. */
  at: number;
  packetsReceived?: number;
  packetsLost?: number;
  bytesReceived?: number;
  /** RFC 3550 interarrival jitter, seconds. A smoothed estimate, not a total. */
  jitter?: number;
  totalSamplesReceived?: number;
  concealedSamples?: number;
  /** Concealment during silence (comfort noise): not audible, so it does not count. */
  silentConcealedSamples?: number;
  concealmentEvents?: number;
  insertedSamplesForDeceleration?: number;
  removedSamplesForAcceleration?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  fecPacketsReceived?: number;
};

/** What happened to the voice between two reads. Percentages are of the window; `jitterMs` is the estimate at its end. */
export type VoiceWindow = {
  seconds: number;
  packets: number;
  lostPct: number;
  /** Audible concealment: samples the browser made up, minus those made up during silence, over all it played. */
  concealedPct: number;
  concealmentEvents: number;
  jitterMs: number;
  /** What the jitter buffer held on average while it played, ms. */
  bufferMs: number;
  /** Samples stretched in to wait for late packets, and cut out to catch up, over all played. */
  decelPct: number;
  accelPct: number;
  fecPackets: number;
  bytesPerPacket: number;
};

const delta = (cur: number | undefined, prev: number | undefined): number => Math.max(0, (cur ?? 0) - (prev ?? 0));
const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** The window from `prev` to `cur`; null when no packet arrived in it (nothing to say, and nothing to react to). */
export function voiceWindow(prev: VoiceCounters, cur: VoiceCounters): VoiceWindow | null {
  const packets = delta(cur.packetsReceived, prev.packetsReceived);
  if (packets === 0) return null;
  const lost = delta(cur.packetsLost, prev.packetsLost);
  const samples = delta(cur.totalSamplesReceived, prev.totalSamplesReceived);
  const concealed = delta(cur.concealedSamples, prev.concealedSamples) - delta(cur.silentConcealedSamples, prev.silentConcealedSamples);
  const emitted = delta(cur.jitterBufferEmittedCount, prev.jitterBufferEmittedCount);
  const held = delta(cur.jitterBufferDelay, prev.jitterBufferDelay);
  return {
    seconds: Math.round((cur.at - prev.at) / 100) / 10,
    packets,
    lostPct: pct(lost, packets + lost),
    concealedPct: pct(Math.max(0, concealed), samples),
    concealmentEvents: delta(cur.concealmentEvents, prev.concealmentEvents),
    jitterMs: Math.round((cur.jitter ?? 0) * 1000),
    bufferMs: emitted > 0 ? Math.round((held / emitted) * 1000) : 0,
    decelPct: pct(delta(cur.insertedSamplesForDeceleration, prev.insertedSamplesForDeceleration), samples),
    accelPct: pct(delta(cur.removedSamplesForAcceleration, prev.removedSamplesForAcceleration), samples),
    fecPackets: delta(cur.fecPacketsReceived, prev.fecPacketsReceived),
    bytesPerPacket: Math.round(delta(cur.bytesReceived, prev.bytesReceived) / packets),
  };
}

/**
 * The voice buffer that follows the line (ticket 34). A window with audible concealment or jitter past the marks raises
 * the friend's `jitterBufferTarget` one step; a clean minute lowers it one step. A raise waits two windows before the
 * next, so the new buffer gets a chance to work. Windows too short to judge (a few packets) are ignored.
 */
export const BUFFER_STEPS_MS = [200, 400] as const;
export const BUFFER_RAISE_CONCEALED_PCT = 3;
export const BUFFER_RAISE_JITTER_MS = 50;
/** Windows, at VOICE_SAMPLE_MS each: a clean minute. */
export const BUFFER_LOWER_AFTER_WINDOWS = 12;
export const BUFFER_SETTLE_WINDOWS = 2;
export const BUFFER_MIN_PACKETS = 40;
export const VOICE_SAMPLE_MS = 5000;
/** Every this many samples a `voice_quality` event goes out: 30 s. */
export const VOICE_REPORT_EVERY = 6;

export type BufferState = { level: number; clean: number; sinceChange: number };
export const INITIAL_BUFFER: BufferState = { level: 0, clean: 0, sinceChange: BUFFER_SETTLE_WINDOWS };

export const isRough = (w: VoiceWindow): boolean => w.concealedPct >= BUFFER_RAISE_CONCEALED_PCT || w.jitterMs >= BUFFER_RAISE_JITTER_MS;

export function nextBuffer(s: BufferState, w: VoiceWindow): BufferState {
  if (w.packets < BUFFER_MIN_PACKETS) return s;
  const sinceChange = s.sinceChange + 1;
  if (isRough(w)) {
    if (s.level < BUFFER_STEPS_MS.length && sinceChange > BUFFER_SETTLE_WINDOWS) return { level: s.level + 1, clean: 0, sinceChange: 0 };
    return { ...s, clean: 0, sinceChange };
  }
  const clean = s.clean + 1;
  if (s.level > 0 && clean >= BUFFER_LOWER_AFTER_WINDOWS) return { level: s.level - 1, clean: 0, sinceChange: 0 };
  return { ...s, clean, sinceChange };
}

/** The target the state asks for, ms, or null for the browser's own. */
export const bufferMs = (s: BufferState): number | null => (s.level > 0 ? BUFFER_STEPS_MS[s.level - 1]! : null);
