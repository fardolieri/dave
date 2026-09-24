import { describe, expect, it } from 'vitest';
import { byteCapacity, encodeQr, qrPath, qrVersionFor, reedSolomon } from '../src/core/qr';

describe('qr', () => {
  it('produces the standard Reed-Solomon check bytes (the 1-M "HELLO WORLD" example)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect([...reedSolomon(data, 10)]).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('knows the byte capacities of level M', () => {
    expect([1, 2, 3, 4, 5, 10, 20, 40].map(byteCapacity)).toEqual([14, 26, 42, 62, 84, 213, 666, 2331]);
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(2331)).toBe(40);
    expect(qrVersionFor(2332)).toBe(null);
    expect(encodeQr('x'.repeat(2332))).toBe(null);
  });

  it('lays out a symbol of the right size with finder patterns, timing lines and the dark module', () => {
    const code = encodeQr('https://example.test/#secret/name')!;
    expect(code.size).toBe(29); // version 3
    const dark = (x: number, y: number) => code.dark[y]![x];
    for (const [cx, cy] of [[3, 3], [code.size - 4, 3], [3, code.size - 4]] as const) {
      expect(dark(cx, cy)).toBe(true); // centre
      expect(dark(cx + 2, cy)).toBe(false); // light ring
      expect(dark(cx + 3, cy)).toBe(true); // dark border
      expect(dark(cx, cy + 3)).toBe(true);
    }
    for (let i = 8; i < code.size - 8; i++) { expect(dark(6, i)).toBe(i % 2 === 0); expect(dark(i, 6)).toBe(i % 2 === 0); }
    expect(dark(8, code.size - 8)).toBe(true);
    expect(dark(22, 22)).toBe(true); // alignment pattern centre of version 3
    expect(dark(21, 21)).toBe(false);
    expect(dark(20, 20)).toBe(true);
  });

  it('is deterministic and changes with the text', () => {
    const a = encodeQr('one'), b = encodeQr('one'), c = encodeQr('two');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('draws one path segment per dark module inside a four-module quiet zone', () => {
    const code = encodeQr('hello')!;
    const path = qrPath(code);
    const darkCount = code.dark.flat().filter(Boolean).length;
    expect(path.match(/M/g)!.length).toBe(darkCount);
    expect(path.startsWith('M4 4h1v1h-1z')).toBe(true); // the top-left finder corner
  });
});
