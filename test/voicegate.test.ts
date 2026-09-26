import { describe, expect, it } from 'vitest';
import { GATE_HOLD_MS, GATE_FRAME_MS, createVoiceGate } from '../src/core/voicegate';

describe('voice gate', () => {
  const frames = (gate: ReturnType<typeof createVoiceGate>, voices: number[], threshold = 0.5) => voices.map((v) => gate(v, threshold));

  it('starts closed and opens on the first frame that reaches the threshold', () => {
    expect(frames(createVoiceGate(), [0, 0.2, 0.49, 0.5, 0.9])).toEqual([false, false, false, true, true]);
  });
  it('holds open for the hold after the last voiced frame, then closes', () => {
    const gate = createVoiceGate();
    gate(0.9, 0.5);
    const hold = GATE_HOLD_MS / GATE_FRAME_MS;
    const after = frames(gate, Array<number>(hold + 1).fill(0));
    expect(after.slice(0, hold)).toEqual(Array<boolean>(hold).fill(true));
    expect(after[hold]).toBe(false);
  });
  it('a voiced frame during the hold starts it again', () => {
    const gate = createVoiceGate(30); // three frames
    expect(frames(gate, [0.9, 0, 0, 0.9, 0, 0, 0, 0])).toEqual([true, true, true, true, true, true, true, false]);
  });
  it('a threshold of 0 lets everything through', () => {
    expect(frames(createVoiceGate(), [0, 0, 0], 0)).toEqual([true, true, true]);
  });
  it('the threshold is read per frame, so moving the slider acts at once', () => {
    const gate = createVoiceGate(0);
    expect([gate(0.6, 0.5), gate(0.6, 0.7)]).toEqual([true, false]);
  });
});
