import { VOICE_PROCESSOR } from '../core/voicegate';
import wasmUrl from './rnnoise/rnnoise-little.wasm?url';
import workletUrl from './voice.worklet.ts?worker&url';
import type { VoiceMessage, VoiceOptions } from './voice.worklet';

/**
 * Noise removal on the outgoing voice (ticket 26): microphone -> RNNoise and the voice gate in an AudioWorklet -> a
 * track to send instead of the microphone's. It runs in an AudioContext of its own at 48 kHz, RNNoise's only rate, so
 * the context that plays everyone else keeps the browser's default rate, and a browser that cannot open this one
 * (Firefox before 148 refuses a microphone at another rate) loses noise removal and nothing else.
 */
export type VoiceProcessor = {
  /** The denoised, gated voice. Silent while the context is not running, so send it only when `running()`. */
  track: MediaStreamTrack;
  /** Settles when RNNoise runs; rejects when it cannot. */
  ready: Promise<void>;
  running(): boolean;
  /** Inside a click, for a context the browser kept suspended. */
  resume(): void;
  setInput(stream: MediaStream): void;
  setThreshold(threshold: number): void;
  close(): void;
};
export type VoiceLevel = { voice: number; open: boolean };

// The smallest module using a SIMD instruction (from wasm-feature-detect); our build needs wasm SIMD.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
/** Checked before the microphone opens, so the browser's own noise suppression is not switched off for nothing. */
export const canRemoveNoise = (): boolean =>
  typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);

let wasm: Promise<ArrayBuffer> | null = null;
const loadWasm = (): Promise<ArrayBuffer> => {
  wasm ??= fetch(wasmUrl).then((r) => { if (!r.ok) throw new Error(`rnnoise ${r.status}`); return r.arrayBuffer(); });
  wasm.catch(() => { wasm = null; }); // a failed download is tried again on the next join
  return wasm;
};

export async function createVoiceProcessor(stream: MediaStream, threshold: number, on: { level(l: VoiceLevel): void; running(): void }): Promise<VoiceProcessor> {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    // Inside the join click, or on a Rejoin with the microphone already live, which lets a context start without a gesture.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    ctx.onstatechange = () => on.running();
    let source = ctx.createMediaStreamSource(stream);
    const [bytes] = await Promise.all([loadWasm(), ctx.audioWorklet.addModule(workletUrl)]);
    const options: VoiceOptions = { wasm: bytes, threshold };
    const node = new AudioWorkletNode(ctx, VOICE_PROCESSOR, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: options,
    });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node).connect(dest);
    const ready = new Promise<void>((resolve, reject) => {
      node.port.onmessage = (e: MessageEvent<VoiceMessage>) => {
        const m = e.data;
        if (m.t === 'level') on.level(m);
        else if (m.t === 'ready') resolve();
        else reject(new Error(m.message));
      };
    });
    ready.catch(() => {}); // awaited by the caller; this only keeps an early failure from being reported as unhandled
    return {
      track: dest.stream.getAudioTracks()[0]!,
      ready,
      running: () => ctx.state === 'running',
      resume: () => { void ctx.resume().catch(() => {}); },
      setInput(next) {
        source.disconnect();
        source = ctx.createMediaStreamSource(next);
        source.connect(node);
      },
      setThreshold: (threshold) => node.port.postMessage({ threshold }),
      close() {
        ctx.onstatechange = null;
        node.port.onmessage = null;
        dest.stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    void ctx.close().catch(() => {});
    throw e;
  }
}
