import { describe, expect, it } from 'vitest';
import { BUFFER_LOWER_AFTER_WINDOWS, BUFFER_SETTLE_WINDOWS, INITIAL_BUFFER, bufferMs, nextBuffer, voiceWindow, type VoiceCounters, type VoiceWindow } from '../src/core/voicequality';

const base: VoiceCounters = { at: 1000, packetsReceived: 1000, packetsLost: 10, bytesReceived: 80_000, jitter: 0.004, totalSamplesReceived: 960_000, concealedSamples: 4800, silentConcealedSamples: 2400, concealmentEvents: 3, insertedSamplesForDeceleration: 480, removedSamplesForAcceleration: 96, jitterBufferDelay: 60, jitterBufferEmittedCount: 1000, fecPacketsReceived: 2 };

describe('voiceWindow', () => {
  it('turns two reads into what happened between them', () => {
    const cur: VoiceCounters = { at: 6000, packetsReceived: 1250, packetsLost: 15, bytesReceived: 100_000, jitter: 0.012, totalSamplesReceived: 1_200_000, concealedSamples: 14_400, silentConcealedSamples: 4800, concealmentEvents: 7, insertedSamplesForDeceleration: 2880, removedSamplesForAcceleration: 96, jitterBufferDelay: 110, jitterBufferEmittedCount: 1250, fecPacketsReceived: 5 };
    expect(voiceWindow(base, cur)).toEqual({
      seconds: 5, packets: 250, lostPct: 2, // 5 of 255
      concealedPct: 3, // (9600 - 2400) of 240000
      concealmentEvents: 4, jitterMs: 12,
      bufferMs: 200, // 50 s more delay over 250 emitted
      decelPct: 1, accelPct: 0, fecPackets: 3, bytesPerPacket: 80,
    });
  });
  it('is null when nothing arrived, and copes with counters a browser lacks', () => {
    expect(voiceWindow(base, { ...base, at: 6000 })).toBeNull();
    expect(voiceWindow({ at: 0, packetsReceived: 0 }, { at: 5000, packetsReceived: 100 })).toMatchObject({ packets: 100, lostPct: 0, concealedPct: 0, jitterMs: 0, bufferMs: 0, bytesPerPacket: 0 });
  });
  it('never reports negative concealment when the silent part outruns the whole (counters reset)', () => {
    expect(voiceWindow(base, { ...base, at: 6000, packetsReceived: 1100, concealedSamples: 4800, silentConcealedSamples: 9000 })!.concealedPct).toBe(0);
  });
});

const clean: VoiceWindow = { seconds: 5, packets: 250, lostPct: 0, concealedPct: 0.2, concealmentEvents: 1, jitterMs: 8, bufferMs: 60, decelPct: 0, accelPct: 0, fecPackets: 0, bytesPerPacket: 80 };
const rough: VoiceWindow = { ...clean, concealedPct: 4.5, concealmentEvents: 12 };
const jittery: VoiceWindow = { ...clean, jitterMs: 70 };
const feed = (s = INITIAL_BUFFER, ...windows: VoiceWindow[]) => windows.reduce(nextBuffer, s);

describe('the voice buffer that follows the line', () => {
  it('starts with the browser\'s own buffer and raises one step on a rough window', () => {
    expect(bufferMs(INITIAL_BUFFER)).toBeNull();
    expect(bufferMs(feed(INITIAL_BUFFER, rough))).toBe(200);
    expect(bufferMs(feed(INITIAL_BUFFER, jittery))).toBe(200);
  });
  it('waits for the raise to settle before the next one, and stops at the top step', () => {
    let s = feed(INITIAL_BUFFER, rough);
    for (let i = 0; i < BUFFER_SETTLE_WINDOWS; i++) { s = nextBuffer(s, rough); expect(bufferMs(s)).toBe(200); }
    s = nextBuffer(s, rough);
    expect(bufferMs(s)).toBe(400);
    for (let i = 0; i < 10; i++) s = nextBuffer(s, rough);
    expect(bufferMs(s)).toBe(400);
  });
  it('lowers one step after a clean minute, and a rough window in between starts the minute over', () => {
    let s = feed(INITIAL_BUFFER, rough);
    for (let i = 0; i < BUFFER_LOWER_AFTER_WINDOWS - 1; i++) s = nextBuffer(s, clean);
    expect(bufferMs(s)).toBe(200);
    expect(bufferMs(nextBuffer(s, rough))).toBe(400); // settled long ago, so a rough window steps up instead
    s = nextBuffer(s, clean);
    expect(bufferMs(s)).toBeNull();
    // At the top step a rough window cannot raise; it still starts the clean minute over.
    let top = feed(INITIAL_BUFFER, rough, rough, rough, rough);
    expect(bufferMs(top)).toBe(400);
    for (let i = 0; i < BUFFER_LOWER_AFTER_WINDOWS - 1; i++) top = nextBuffer(top, clean);
    top = nextBuffer(top, rough);
    expect(top.clean).toBe(0);
    for (let i = 0; i < BUFFER_LOWER_AFTER_WINDOWS - 1; i++) top = nextBuffer(top, clean);
    expect(bufferMs(top)).toBe(400);
    expect(bufferMs(nextBuffer(top, clean))).toBe(200);
  });
  it('ignores a window with too few packets to judge', () => {
    expect(feed(INITIAL_BUFFER, { ...rough, packets: 12 })).toBe(INITIAL_BUFFER);
  });
});
