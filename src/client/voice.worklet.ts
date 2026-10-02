// Runs in the AudioWorkletGlobalScope (ticket 26); Vite bundles this file and its imports on their own.
// RNNoise (little model, our standalone wasm build: scripts/build-rnnoise.sh) denoises 10 ms frames and reports each
// frame's voice probability, which drives the voice gate. Until RNNoise is ready the input passes through untouched.
// Browsers without the microphone's own frames take this path (ticket 37: client/voice.worker.ts is the other).
import { VOICE_PROCESSOR } from '../core/voicegate';
import { FRAME, createFrameProcessor, loadRnnoise } from './denoise';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export type VoiceOptions = { wasm: ArrayBuffer; threshold: number };
/** To the page: ready or failed once, then the level meter 20 times a second. */
export type VoiceMessage = { t: 'ready' } | { t: 'error'; message: string } | { t: 'level'; voice: number; open: boolean };

class VoiceProcessor extends AudioWorkletProcessor {
  private frames: ReturnType<typeof createFrameProcessor> | null = null;
  private threshold: number;
  private readonly frame = new Float32Array(FRAME);
  private framePos = 0;
  // Processed samples wait here until the render quanta (128 samples) take them; one frame of silence goes first.
  private readonly fifo = new Float32Array(FRAME * 4);
  private readPos = 0;
  private writePos = FRAME;

  constructor(options: { processorOptions: VoiceOptions }) {
    super(options);
    this.threshold = options.processorOptions.threshold;
    this.port.onmessage = (e: MessageEvent<{ threshold: number }>) => { this.threshold = e.data.threshold; this.frames?.setThreshold(this.threshold); };
    if (sampleRate !== 48000) { this.port.postMessage({ t: 'error', message: `sample rate ${sampleRate}` } satisfies VoiceMessage); return; }
    loadRnnoise(options.processorOptions.wasm)
      .then((r) => {
        this.frames = createFrameProcessor(r, this.threshold, (l) => this.port.postMessage({ t: 'level', ...l } satisfies VoiceMessage));
        this.port.postMessage({ t: 'ready' } satisfies VoiceMessage);
      })
      .catch((e: unknown) => this.port.postMessage({ t: 'error', message: String(e) } satisfies VoiceMessage));
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!this.frames) { if (input) output.set(input); return true; }
    for (let i = 0; i < output.length; i++) {
      this.frame[this.framePos++] = input ? input[i]! : 0;
      if (this.framePos === FRAME) { this.processFrame(this.frames); this.framePos = 0; }
      output[i] = this.fifo[this.readPos]!;
      this.readPos = (this.readPos + 1) % this.fifo.length;
    }
    return true;
  }

  private processFrame(frames: ReturnType<typeof createFrameProcessor>): void {
    frames.process(this.frame);
    for (let i = 0; i < FRAME; i++) {
      this.fifo[this.writePos] = this.frame[i]!;
      this.writePos = (this.writePos + 1) % this.fifo.length;
    }
  }
}

registerProcessor(VOICE_PROCESSOR, VoiceProcessor);
