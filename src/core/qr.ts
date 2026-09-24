// QR codes (ISO/IEC 18004), enough to show an invite link on screen for a phone to scan: byte mode, error
// correction level M, any version 1 to 40, the mask chosen by the standard's penalty rules. Written here
// because core takes no dependencies and the whole encoder is shorter than a package's type definitions.

/** A finished symbol: `size` modules a side, `dark[y][x]` true where a module is dark. No quiet zone. */
export type QrCode = { size: number; dark: boolean[][] };

/** Error-correction codewords per block and number of blocks, level M, indexed by version (index 0 unused). */
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

/** All codewords a version holds: the modules left after the function patterns, in bytes. */
function totalCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    bits -= (25 * align - 10) * align - 55;
    if (version >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

const dataCodewords = (version: number): number => totalCodewords(version) - EC_PER_BLOCK[version]! * BLOCKS[version]!;

/** Bytes of data a version carries in byte mode: the codewords minus the mode and length header. */
export const byteCapacity = (version: number): number => dataCodewords(version) - (version < 10 ? 2 : 3);

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++, x = x << 1 ^ (x & 0x80 ? 0x11d : 0)) { EXP[i] = x; LOG[x] = i; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** Reed-Solomon remainder: `degree` check bytes for `data`, generator roots α^0 to α^(degree-1). */
export function reedSolomon(data: ArrayLike<number>, degree: number): Uint8Array {
  const gen = new Uint8Array(degree);
  gen[degree - 1] = 1;
  for (let root = 1, i = 0; i < degree; i++, root = mul(root, 2)) {
    for (let j = 0; j < degree; j++) gen[j] = mul(gen[j]!, root) ^ (j + 1 < degree ? gen[j + 1]! : 0);
  }
  const rem = new Uint8Array(degree);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let j = 0; j < degree; j++) rem[j] = rem[j]! ^ mul(gen[j]!, factor);
  }
  return rem;
}

/** The data as codewords: header, bytes, terminator, padding to the version's capacity. */
function dataBytes(bytes: Uint8Array, version: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, count: number) => { for (let i = count - 1; i >= 0; i--) bits.push(value >>> i & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out = new Uint8Array(capacity / 8);
  for (let i = 0; i < bits.length; i++) out[i >>> 3] = out[i >>> 3]! | bits[i]! << (7 - (i & 7));
  return out;
}

/** Data split into blocks, each with its check bytes, then interleaved codeword by codeword. */
function codewords(data: Uint8Array, version: number): Uint8Array {
  const blocks = BLOCKS[version]!, ec = EC_PER_BLOCK[version]!, total = totalCodewords(version);
  const shortBlocks = blocks - total % blocks, shortLen = Math.floor(total / blocks) - ec;
  const parts: { data: Uint8Array; ec: Uint8Array }[] = [];
  for (let b = 0, at = 0; b < blocks; b++) {
    const len = shortLen + (b < shortBlocks ? 0 : 1);
    const d = data.subarray(at, at + len);
    parts.push({ data: d, ec: reedSolomon(d, ec) });
    at += len;
  }
  const out = new Uint8Array(total);
  let i = 0;
  for (let k = 0; k <= shortLen; k++) for (const p of parts) if (k < p.data.length) out[i++] = p.data[k]!;
  for (let k = 0; k < ec; k++) for (const p of parts) out[i++] = p.ec[k]!;
  return out;
}

/** BCH remainder over GF(2) for the format (10 bits, 0x537) and version (12 bits, 0x1f25) information. */
function bch(value: number, poly: number, degree: number): number {
  let rem = value;
  for (let i = 31 - Math.clz32(rem); i >= degree; i--) if (rem >>> i & 1) rem ^= poly << (i - degree);
  return rem;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

/** The smallest version that holds `text` in byte mode at level M, or null past version 40 (2331 bytes). */
export function qrVersionFor(bytes: number): number | null {
  for (let v = 1; v <= 40; v++) if (byteCapacity(v) >= bytes) return v;
  return null;
}

/** The QR code for `text` (UTF-8, byte mode, level M), or null when it does not fit any version. */
export function encodeQr(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (version === null) return null;
  const size = version * 4 + 17;
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean) => { dark[y]![x] = on; fixed[y]![x] = true; };

  // Function patterns: timing lines, the three finders with their separators, alignment patterns, dark module.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const at = [6];
    for (let pos = size - 7; at.length < count; pos -= step) at.splice(1, 0, pos);
    for (const cx of at) for (const cy of at) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // Format information goes in with the mask; its cells are reserved here so no data lands on them.
  const format = (mask: number) => {
    const data = 0b00 << 3 | mask; // level M is 00
    const bits = (data << 10 | bch(data << 10, 0x537, 10)) ^ 0x5412;
    const bit = (i: number) => (bits >>> i & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    const bits = version << 12 | bch(version << 12, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const on = (bits >>> i & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, on); set(b, a, on);
    }
  }

  // Codewords, most significant bit first, in two-module columns zigzagging up and down from the right.
  const words = codewords(dataBytes(bytes, version), version);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fixed[y]![x] && i < words.length * 8) { dark[y]![x] = (words[i >>> 3]! >>> (7 - (i & 7)) & 1) === 1; i++; }
    }
  }

  // The mask with the lowest penalty wins. Masking flips data modules only; the format bits follow the mask.
  const apply = (mask: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && MASKS[mask]!(x, y)) dark[y]![x] = !dark[y]![x]; };
  let best = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask); format(mask);
    const penalty = penaltyOf(dark, size);
    if (penalty < bestPenalty) { best = mask; bestPenalty = penalty; }
    apply(mask);
  }
  apply(best); format(best);
  return { size, dark };
}

/** The standard's four penalty rules: runs of one colour, 2x2 blocks, finder look-alikes, dark-light balance. */
function penaltyOf(dark: boolean[][], size: number): number {
  let penalty = 0, darkCount = 0;
  // A 1:1:3:1:1 dark-light run with four light modules on at least one side reads as a finder pattern.
  const finderLike = (h: number[]): number => {
    const n = h[1]!, core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0);
  };
  const line = (cell: (i: number) => boolean) => {
    // The seven latest run lengths, newest first; the light border beyond the symbol counts as `size` light modules.
    const history = [0, 0, 0, 0, 0, 0, 0];
    const record = (run: number) => { history.pop(); history.unshift(run + (history[0] === 0 ? size : 0)); };
    let colour = false, run = 0;
    for (let i = 0; i < size; i++) {
      if (cell(i) === colour) { run++; if (run === 5) penalty += 3; else if (run > 5) penalty += 1; continue; }
      record(run);
      if (!colour) penalty += 40 * finderLike(history);
      colour = cell(i); run = 1;
    }
    if (colour) { record(run); run = 0; }
    record(run + size);
    penalty += 40 * finderLike(history);
  };
  for (let y = 0; y < size; y++) line((x) => dark[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => dark[y]![x]!);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = dark[y]![x];
    if (c) darkCount++;
    if (y + 1 < size && x + 1 < size && dark[y]![x + 1] === c && dark[y + 1]![x] === c && dark[y + 1]![x + 1] === c) penalty += 3;
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  return penalty + k * 10;
}

/** An SVG path (one `M x y h1 v1 h-1 z` per dark module) for the code, offset by a quiet zone of `margin` modules. */
export function qrPath(code: QrCode, margin = 4): string {
  let d = '';
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.dark[y]![x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  return d;
}
