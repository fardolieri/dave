/**
 * The voice gate (ticket 26), fed one RNNoise frame at a time. It opens on a frame whose voice probability reaches the
 * threshold and stays open for the hold after the last such frame, so word endings and short pauses pass. A threshold
 * of 0 keeps it open.
 */
export const GATE_FRAME_MS = 10;
/** The AudioWorklet processor that runs RNNoise and this gate (client/voice.worklet.ts). */
export const VOICE_PROCESSOR = 'dave-voice';
export const GATE_HOLD_MS = 300;

export function createVoiceGate(holdMs = GATE_HOLD_MS): (voice: number, threshold: number) => boolean {
  const holdFrames = Math.round(holdMs / GATE_FRAME_MS);
  let sinceVoice = Infinity;
  return (voice, threshold) => {
    sinceVoice = voice >= threshold ? 0 : sinceVoice + 1;
    return sinceVoice <= holdFrames;
  };
}
