// Noise removal on the microphone's own frames (ticket 37), in a dedicated worker: the page hands over the readable side
// of a MediaStreamTrackProcessor on the microphone and the writable side of a MediaStreamTrackGenerator, and every
// frame that comes in goes out as soon as RNNoise and the gate are through with it. The microphone sets the pace, so
// the voice sent cannot run faster or slower than it speaks, which the AudioContext of the worklet path could.
import { createResampler } from '../core/voiceclock';
import { FRAME, createFrameProcessor, loadRnnoise } from './denoise';

export type WorkerIn =
  | { t: 'start'; wasm: ArrayBuffer; threshold: number; readable: ReadableStream<AudioData>; writable: WritableStream<AudioData> }
  | { t: 'input'; readable: ReadableStream<AudioData> }
  | { t: 'threshold'; threshold: number };
/** To the page: ready or failed once, the level meter 20 times a second, the processing load once a second of audio. */
export type WorkerOut = { t: 'ready' } | { t: 'error'; message: string } | { t: 'level'; voice: number; open: boolean } | { t: 'load'; pct: number };

const RATE = 48000; // RNNoise's only rate
const LOAD_FRAMES = 100; // a second of audio

const post = (m: WorkerOut) => postMessage(m);
let frames: ReturnType<typeof createFrameProcessor> | null = null;
let threshold = 0.5;
let writer: WritableStreamDefaultWriter<AudioData> | null = null;
let reader: ReadableStreamDefaultReader<AudioData> | null = null;

// Samples at 48 kHz waiting for a whole frame; a frame holds at most one input chunk more than that.
let pending = new Float32Array(FRAME * 8);
let pendingLen = 0;
let resample: ((x: Float32Array) => Float32Array) | null = null;
let inputRate = 0;
let outTs: number | null = null; // µs, from the first frame's timestamp on, in 10 ms steps
let busyMs = 0;
let busyFrames = 0;

function take(data: AudioData): void {
  outTs ??= data.timestamp;
  if (data.sampleRate !== inputRate) { inputRate = data.sampleRate; resample = createResampler(inputRate, RATE); }
  const raw = new Float32Array(data.numberOfFrames);
  data.copyTo(raw, { planeIndex: 0, format: 'f32-planar' }); // the first channel: the voice is sent mono
  data.close();
  const x = resample!(raw);
  if (pendingLen + x.length > pending.length) { const grown = new Float32Array((pendingLen + x.length) * 2); grown.set(pending.subarray(0, pendingLen)); pending = grown; }
  pending.set(x, pendingLen);
  pendingLen += x.length;
  let at = 0;
  while (pendingLen - at >= FRAME) {
    const frame = pending.slice(at, at + FRAME);
    at += FRAME;
    if (frames) {
      const t0 = performance.now();
      frames.process(frame);
      busyMs += performance.now() - t0;
      if (++busyFrames === LOAD_FRAMES) { post({ t: 'load', pct: Math.round(busyMs / (LOAD_FRAMES * 10) * 100) }); busyMs = 0; busyFrames = 0; }
    }
    const out = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: outTs, data: frame });
    outTs += (FRAME / RATE) * 1e6;
    writer?.write(out).catch(() => out.close());
  }
  pending.copyWithin(0, at, pendingLen);
  pendingLen -= at;
}

async function pump(readable: ReadableStream<AudioData>): Promise<void> {
  const mine = readable.getReader();
  const old = reader;
  reader = mine;
  void old?.cancel().catch(() => {});
  for (;;) {
    let r: ReadableStreamReadResult<AudioData>;
    try { r = await mine.read(); } catch { return; }
    if (r.done) return;
    if (reader !== mine) { r.value.close(); return; }
    take(r.value);
  }
}

onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.t === 'threshold') { threshold = m.threshold; frames?.setThreshold(threshold); return; }
  if (m.t === 'input') { void pump(m.readable); return; }
  threshold = m.threshold;
  writer = m.writable.getWriter();
  void pump(m.readable);
  loadRnnoise(m.wasm)
    .then((r) => { frames = createFrameProcessor(r, threshold, (l) => post({ t: 'level', ...l })); post({ t: 'ready' }); })
    .catch((err: unknown) => post({ t: 'error', message: String(err) }));
};
