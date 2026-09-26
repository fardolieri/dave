// Runs in the AudioWorkletGlobalScope (ticket 26); Vite bundles this file and its imports on their own.
// RNNoise (little model, our standalone wasm build: scripts/build-rnnoise.sh) denoises 10 ms frames and reports each
// frame's voice probability, which drives the voice gate. Until RNNoise is ready the input passes through untouched.
import { GATE_FRAME_MS, VOICE_PROCESSOR, createVoiceGate } from '../core/voicegate';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export type VoiceOptions = { wasm: ArrayBuffer; threshold: number };
/** To the page: ready or failed once, then the level meter 20 times a second. */
export type VoiceMessage = { t: 'ready' } | { t: 'error'; message: string } | { t: 'level'; voice: number; open: boolean };

const FRAME = 480; // RNNoise's frame: 10 ms at 48 kHz
const RELEASE_MS = 60; // the gate opens within one frame and closes over this, so it neither clicks nor clips a word
const REPORT_FRAMES = 5;

type Rnnoise = (frame: Float32Array) => number;
async function loadRnnoise(bytes: ArrayBuffer): Promise<Rnnoise> {
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

class VoiceProcessor extends AudioWorkletProcessor {
  private rnnoise: Rnnoise | null = null;
  private threshold: number;
  private readonly gate = createVoiceGate();
  private readonly frame = new Float32Array(FRAME);
  private framePos = 0;
  // Processed samples wait here until the render quanta (128 samples) take them; one frame of silence goes first.
  private readonly fifo = new Float32Array(FRAME * 4);
  private readPos = 0;
  private writePos = FRAME;
  private gain = 0;
  private reportVoice = 0;
  private reportOpen = false;
  private reportFrames = 0;

  constructor(options: { processorOptions: VoiceOptions }) {
    super(options);
    this.threshold = options.processorOptions.threshold;
    this.port.onmessage = (e: MessageEvent<{ threshold: number }>) => { this.threshold = e.data.threshold; };
    if (sampleRate !== 48000) { this.port.postMessage({ t: 'error', message: `sample rate ${sampleRate}` } satisfies VoiceMessage); return; }
    loadRnnoise(options.processorOptions.wasm)
      .then((r) => { this.rnnoise = r; this.port.postMessage({ t: 'ready' } satisfies VoiceMessage); })
      .catch((e: unknown) => this.port.postMessage({ t: 'error', message: String(e) } satisfies VoiceMessage));
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!this.rnnoise) { if (input) output.set(input); return true; }
    for (let i = 0; i < output.length; i++) {
      this.frame[this.framePos++] = input ? input[i]! : 0;
      if (this.framePos === FRAME) { this.processFrame(this.rnnoise); this.framePos = 0; }
      output[i] = this.fifo[this.readPos]!;
      this.readPos = (this.readPos + 1) % this.fifo.length;
    }
    return true;
  }

  private processFrame(rnnoise: Rnnoise): void {
    const voice = rnnoise(this.frame);
    const open = this.gate(voice, this.threshold);
    const step = open ? 1 / FRAME : -GATE_FRAME_MS / RELEASE_MS / FRAME;
    for (let i = 0; i < FRAME; i++) {
      this.gain = Math.min(1, Math.max(0, this.gain + step));
      this.fifo[this.writePos] = this.frame[i]! * this.gain;
      this.writePos = (this.writePos + 1) % this.fifo.length;
    }
    this.reportVoice = Math.max(this.reportVoice, voice);
    this.reportOpen ||= open;
    if (++this.reportFrames === REPORT_FRAMES) {
      this.port.postMessage({ t: 'level', voice: this.reportVoice, open: this.reportOpen } satisfies VoiceMessage);
      this.reportVoice = 0; this.reportOpen = false; this.reportFrames = 0;
    }
  }
}

registerProcessor(VOICE_PROCESSOR, VoiceProcessor);
