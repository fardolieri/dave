/**
 * Keeping the outgoing voice on time (ticket 37). Noise removal used to run in an AudioContext of its own, clocked by
 * the output device, not by the microphone; with a USB-C headset on a phone, and with WebAssembly interpreted (Vanadium
 * without JIT), friends received 3 to 20 percent more voice than real time and played it sped up behind a 2 s buffer.
 * Runtime-neutral: the resampler that lets the microphone's own frames feed RNNoise at 48 kHz, and the guard that stops
 * noise removal when the voice it sends runs off the clock or the processing cannot keep up.
 */

/**
 * Linear interpolation from one rate to another over a stream of chunks, carrying the phase and the last sample across
 * chunk edges so no click or gap appears between them. Good enough for a voice that RNNoise then band-limits anyway.
 */
export function createResampler(fromRate: number, toRate: number): (input: Float32Array) => Float32Array {
  if (fromRate === toRate) return (input) => input;
  const step = fromRate / toRate; // input samples per output sample
  let pos = 0; // position of the next output sample, in input samples, relative to the start of the current chunk
  let last = 0; // the previous chunk's last sample, at position -1
  return (input) => {
    const n = input.length;
    const out: number[] = [];
    // An output sample at `pos` needs input at floor(pos) and floor(pos) + 1; the last one of this chunk waits for the next.
    while (pos < n - 1) {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = i < 0 ? last : input[i]!;
      out.push(a + (input[i + 1]! - a) * f);
      pos += step;
    }
    if (n > 0) last = input[n - 1]!;
    pos -= n;
    return Float32Array.from(out);
  };
}

/** One reading of the sent voice: wall clock and audio the track has delivered, ms; and the processing load, percent. */
export type ClockSample = { at: number; audioMs: number; loadPct?: number | null };
export type GuardFault = { reason: 'drift' | 'overload'; ratePct: number; loadPct: number | null };

/** Judged over this much wall time: long enough that the 10 ms steps of the counter and a stall or two average out. */
export const DRIFT_WINDOW_MS = 10_000;
/** Off real time by more than this, in either direction. Clean lines measured 0.0 to 0.1 percent; the bad ones 3 to 20. */
export const DRIFT_LIMIT_PCT = 2;
/** Readings in a row past the limit: one stall right at the edge of the window does not count. */
export const DRIFT_SAMPLES = 3;
/** Processing time over audio time, sustained over OVERLOAD_SAMPLES readings (one a second). */
export const OVERLOAD_PCT = 80;
export const OVERLOAD_SAMPLES = 5;
/** The first readings after a start are ignored: the pipeline fills its buffers then. */
export const GUARD_WARMUP_MS = 3_000;

/**
 * Fed a reading about once a second while the processed voice goes to at least one friend. Returns a fault the first
 * time the voice runs off the clock or the load stays too high, null otherwise. A reading in which no audio advanced
 * (no friend took it, a track swapped) starts the measurement over.
 */
export function createVoiceGuard() {
  let samples: ClockSample[] = [];
  let startedAt: number | null = null;
  let heavy = 0;
  let off = 0;
  return {
    reset(): void { samples = []; startedAt = null; heavy = 0; off = 0; },
    feed(s: ClockSample): GuardFault | null {
      startedAt ??= s.at;
      if (s.at - startedAt < GUARD_WARMUP_MS) return null;
      const prev = samples.at(-1);
      if (prev && s.audioMs <= prev.audioMs) { samples = []; off = 0; }
      samples.push(s);
      heavy = typeof s.loadPct === 'number' && s.loadPct >= OVERLOAD_PCT ? heavy + 1 : 0;
      // The oldest reading kept is the newest one at least a window back.
      while (samples.length > 2 && s.at - samples[1]!.at >= DRIFT_WINDOW_MS) samples.shift();
      const first = samples[0]!;
      const rate = s.at > first.at ? (s.audioMs - first.audioMs) / (s.at - first.at) : 1;
      const ratePct = Math.round(rate * 1000) / 10;
      const loadPct = s.loadPct ?? null;
      if (heavy >= OVERLOAD_SAMPLES) return { reason: 'overload', ratePct, loadPct };
      off = s.at - first.at >= DRIFT_WINDOW_MS && Math.abs(ratePct - 100) > DRIFT_LIMIT_PCT ? off + 1 : 0;
      if (off >= DRIFT_SAMPLES) return { reason: 'drift', ratePct, loadPct };
      return null;
    },
  };
}

/** The sent voice between two readings, for `voice_send`: audio delivered over wall time, percent; null without either. */
export function sendRatePct(prev: ClockSample, cur: ClockSample): number | null {
  const wall = cur.at - prev.at;
  const audio = cur.audioMs - prev.audioMs;
  if (wall <= 0 || audio <= 0) return null;
  return Math.round((audio / wall) * 1000) / 10;
}
