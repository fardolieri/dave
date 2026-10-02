// RNNoise and the voice gate on 10 ms frames (tickets 26, 37), shared by the two places noise removal runs: the
// AudioWorklet (client/voice.worklet.ts) and the worker fed by the microphone's own frames (client/voice.worker.ts).
// Neither scope has the DOM; both have WebAssembly.
import { GATE_FRAME_MS, createVoiceGate } from '../core/voicegate';

export const FRAME = 480; // RNNoise's frame: 10 ms at 48 kHz
const RELEASE_MS = 60; // the gate opens within one frame and closes over this, so it neither clicks nor clips a word
const REPORT_FRAMES = 5;

export type Rnnoise = (frame: Float32Array) => number;
export async function loadRnnoise(bytes: ArrayBuffer): Promise<Rnnoise> {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { emscripten_notify_memory_growth: () => {} } });
  const e = instance.exports as unknown as {
    memory: WebAssembly.Memory; _initialize(): void; malloc(n: number): number;
    rnnoise_create(model: number): number; rnnoise_process_frame(st: number, out: number, inp: number): number;
  };
  e._initialize();
  const st = e.rnnoise_create(0);
  const inP = e.malloc(FRAME * 4);
  const outP = e.malloc(FRAME * 4);
  // RNNoise takes and returns samples in the 16-bit range, in place here. Views are made per call: memory may grow.
  return (frame) => {
    const inp = new Float32Array(e.memory.buffer, inP, FRAME);
    for (let i = 0; i < FRAME; i++) inp[i] = frame[i]! * 32768;
    const voice = e.rnnoise_process_frame(st, outP, inP);
    const out = new Float32Array(e.memory.buffer, outP, FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = out[i]! / 32768;
    return voice;
  };
}

/** The level meter, REPORT_FRAMES frames at a time: the highest voice probability, and whether the gate was open. */
export type FrameLevel = { voice: number; open: boolean };

/**
 * Denoises one frame in place and applies the gate with its ramp. `level` fires every REPORT_FRAMES frames (20 times a
 * second).
 */
export function createFrameProcessor(rnnoise: Rnnoise, threshold: number, level: (l: FrameLevel) => void) {
  const gate = createVoiceGate();
  let gain = 0;
  let reportVoice = 0;
  let reportOpen = false;
  let reportFrames = 0;
  return {
    setThreshold(t: number): void { threshold = t; },
    process(frame: Float32Array): void {
      const voice = rnnoise(frame);
      const open = gate(voice, threshold);
      const step = open ? 1 / FRAME : -GATE_FRAME_MS / RELEASE_MS / FRAME;
      for (let i = 0; i < FRAME; i++) {
        gain = Math.min(1, Math.max(0, gain + step));
        frame[i] = frame[i]! * gain;
      }
      reportVoice = Math.max(reportVoice, voice);
      reportOpen ||= open;
      if (++reportFrames === REPORT_FRAMES) {
        level({ voice: reportVoice, open: reportOpen });
        reportVoice = 0; reportOpen = false; reportFrames = 0;
      }
    },
  };
}
