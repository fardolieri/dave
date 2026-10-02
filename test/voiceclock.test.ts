import { describe, expect, it } from 'vitest';
import { DRIFT_SAMPLES, DRIFT_WINDOW_MS, GUARD_WARMUP_MS, OVERLOAD_SAMPLES, createResampler, createVoiceGuard, sendRatePct, type ClockSample } from '../src/core/voiceclock';

describe('createResampler', () => {
  it('passes a matching rate through untouched', () => {
    const r = createResampler(48000, 48000);
    const x = new Float32Array([1, 2, 3]);
    expect(r(x)).toBe(x);
  });
  it('makes as many samples as the rates ask for over a stream of chunks, whatever the chunk size', () => {
    for (const from of [16000, 44100, 96000]) {
      const r = createResampler(from, 48000);
      let made = 0;
      const chunk = from / 100; // 10 ms
      for (let i = 0; i < 300; i++) made += r(new Float32Array(chunk)).length;
      expect(Math.abs(made - 3 * 48000)).toBeLessThanOrEqual(3); // the last sample or two wait for the next chunk
    }
  });
  it('follows a ramp across chunk edges without a jump', () => {
    const r = createResampler(16000, 48000);
    let t = 0;
    const out: number[] = [];
    for (let c = 0; c < 4; c++) out.push(...r(Float32Array.from({ length: 160 }, () => t++)));
    // A ramp of one per input sample is a third per output sample, also where the chunks meet.
    for (let i = 1; i < out.length; i++) expect(out[i]! - out[i - 1]!).toBeCloseTo(1 / 3, 4);
  });
});

/** Readings once a second from 0, the audio running at `rate` of real time, with an optional load. */
function readings(seconds: number, rate: number, loadPct?: number, startAudio = 0, startAt = 0): ClockSample[] {
  return Array.from({ length: seconds + 1 }, (_, i) => ({ at: startAt + i * 1000, audioMs: startAudio + i * 1000 * rate, loadPct }));
}
const firstFault = (guard: ReturnType<typeof createVoiceGuard>, xs: ClockSample[]) => {
  for (const x of xs) { const f = guard.feed(x); if (f) return { at: x.at, ...f }; }
  return null;
};

describe('createVoiceGuard, worklet path', () => {
  const guard = () => createVoiceGuard('context');
  it('stays quiet on a voice in real time and the small steps of the counter', () => {
    const xs = readings(120, 1).map((x, i) => ({ ...x, audioMs: x.audioMs + (i % 3) * 10 }));
    expect(firstFault(guard(), xs)).toBeNull();
  });
  it('stops a voice that runs 3 percent fast, as the USB-C headset did, once a window is measured', () => {
    const f = firstFault(guard(), readings(60, 1.03));
    expect(f).toMatchObject({ reason: 'drift', ratePct: 103 });
    expect(f!.at).toBe(GUARD_WARMUP_MS + DRIFT_WINDOW_MS + (DRIFT_SAMPLES - 1) * 1000);
  });
  it('stops a voice that falls behind too', () => {
    expect(firstFault(guard(), readings(60, 0.95))).toMatchObject({ reason: 'drift', ratePct: 95 });
  });
  it('ignores the start, where the pipeline fills its buffers', () => {
    // A burst of a second of audio in the first two seconds, real time after.
    const xs = [{ at: 0, audioMs: 0 }, { at: 1000, audioMs: 2000 }, { at: 2000, audioMs: 3000 }, ...readings(60, 1, undefined, 3000, 3000).slice(1)];
    expect(firstFault(guard(), xs)).toBeNull();
  });
  it('judges a stall and the burst after it by the window, not by one reading', () => {
    const xs = readings(60, 1).map((x) => (x.at === 20_000 ? { ...x, audioMs: x.audioMs - 300 } : x));
    expect(firstFault(guard(), xs)).toBeNull();
  });
  it('starts over when no audio advanced, and after a reset', () => {
    const g = guard();
    // Nobody took the voice for a while (no friend), then real time: the pause is no drift.
    const xs = [...readings(10, 1), ...readings(10, 0, undefined, 10_000, 11_000).slice(1), ...readings(40, 1, undefined, 10_000, 21_000).slice(1)];
    expect(firstFault(g, xs)).toBeNull();
    g.reset();
    expect(firstFault(g, readings(60, 1, undefined, 0, 100_000))).toBeNull();
  });
});

describe('createVoiceGuard, worker path', () => {
  const guard = () => createVoiceGuard('frames');
  const strained = (xs: ClockSample[], droppedMs: number) => xs.map((x) => ({ ...x, droppedMs }));
  it('never judges the clock or the load: the microphone sets the pace, and a busy phone that keeps up is fine', () => {
    // What stopped a friend's noise removal on 2 Oct though his voice arrived on time: the rate or the load past the old marks.
    expect(firstFault(guard(), strained(readings(120, 1.03, 95), 0))).toBeNull();
    expect(firstFault(guard(), strained(readings(120, 0.95, 85), 0))).toBeNull();
  });
  it('stays quiet through a moment of lost frames', () => {
    const xs = strained(readings(60, 1, 30), 0).map((x, i) => (i % 3 === 0 ? { ...x, droppedMs: 150 } : x));
    expect(firstFault(guard(), xs)).toBeNull();
  });
  it('stops when audio keeps getting lost on the way in', () => {
    const f = firstFault(guard(), strained(readings(30, 1, 99), 200));
    expect(f).toMatchObject({ reason: 'overload', droppedMs: 200, loadPct: 99 });
    expect(f!.at).toBe(GUARD_WARMUP_MS + (OVERLOAD_SAMPLES - 1) * 1000);
  });
});

describe('sendRatePct', () => {
  it('is audio over wall time, null when nothing moved', () => {
    expect(sendRatePct({ at: 0, audioMs: 0 }, { at: 30_000, audioMs: 31_000 })).toBe(103.3);
    expect(sendRatePct({ at: 0, audioMs: 5 }, { at: 30_000, audioMs: 5 })).toBeNull();
    expect(sendRatePct({ at: 0, audioMs: 0 }, { at: 0, audioMs: 10 })).toBeNull();
  });
});
