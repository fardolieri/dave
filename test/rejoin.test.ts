import { describe, expect, it } from 'vitest';
import { REJOIN_WINDOW_MS, parseRejoinMarker, rejoinFor } from '../src/core/rejoin';

describe('rejoin marker', () => {
  const marker = { room: 'r1', at: 1_000_000, watching: ['alice'] };

  it('round-trips and tolerates junk', () => {
    expect(parseRejoinMarker(JSON.stringify(marker))).toEqual(marker);
    expect(parseRejoinMarker(null)).toBeNull();
    expect(parseRejoinMarker('not json')).toBeNull();
    expect(parseRejoinMarker(JSON.stringify({ room: 'r1' }))).toBeNull();
    expect(parseRejoinMarker(JSON.stringify({ room: 'r1', at: 5, watching: ['a', 3, null] }))).toEqual({ room: 'r1', at: 5, watching: ['a'] });
    expect(parseRejoinMarker(JSON.stringify({ room: 'r1', at: 5 }))).toEqual({ room: 'r1', at: 5, watching: [] });
  });

  it('rejoins only the named room, and only inside the window', () => {
    expect(rejoinFor(marker, 'r1', marker.at + 1)).toBe(marker);
    expect(rejoinFor(marker, 'r1', marker.at + REJOIN_WINDOW_MS - 1)).toBe(marker);
    expect(rejoinFor(marker, 'r1', marker.at + REJOIN_WINDOW_MS)).toBeNull();
    expect(rejoinFor(marker, 'r2', marker.at + 1)).toBeNull();
    expect(rejoinFor(marker, 'r1', marker.at - 5_000)).toBeNull(); // written in the future: a clock jumped, do not trust it
    expect(rejoinFor(null, 'r1', marker.at)).toBeNull();
  });
});
