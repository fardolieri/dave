// Every @font-face of the themes (src/client/themes/*.css) names a file that holds the letters it is declared for.
// A face whose file lacks them still loads, so the browser suite cannot see it: the text silently falls back. This
// happened once, when files sharing a name prefix overwrote each other. Checked here by reading each woff2's
// character map: the face must have 'A' if its unicode-range takes it in, else the first code point of its range.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const dir = new URL('../src/client/themes/', import.meta.url).pathname;

/** The tables of a woff2 font that we read (cmap), by the woff2 rules: a directory, then one brotli stream. */
function tables(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a woff2 file');
  const count = buf.readUInt16BE(12);
  let at = 48;
  const base128 = () => { let v = 0; for (;;) { const b = buf[at++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } };
  const entries = [];
  for (let i = 0; i < count; i++) {
    const flags = buf[at++];
    const known = flags & 0x3f;
    let tag = known;
    if (known === 0x3f) { tag = buf.toString('latin1', at, at + 4); at += 4; }
    const length = base128();
    const version = flags >> 6;
    // glyf (10) and loca (11) are transformed unless version 3; every other table only when version is not 0.
    const transformed = known === 10 || known === 11 ? version !== 3 : version !== 0;
    entries.push({ tag, length: transformed ? base128() : length });
  }
  const data = brotliDecompressSync(buf.subarray(at, at + buf.readUInt32BE(20)));
  const out = new Map();
  let offset = 0;
  for (const e of entries) { out.set(e.tag, data.subarray(offset, offset + e.length)); offset += e.length; }
  return out;
}

/** Whether a cmap table (format 4 or 12, Windows Unicode) maps the code point. */
function maps(cmap, cp) {
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const t = cmap.subarray(cmap.readUInt32BE(4 + i * 8 + 4));
    const format = t.readUInt16BE(0);
    if (format === 4) {
      const segs = t.readUInt16BE(6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = t.readUInt16BE(14 + s * 2), start = t.readUInt16BE(16 + segs * 2 + s * 2);
        if (cp >= start && cp <= end && start !== 0xffff) return true;
      }
    } else if (format === 12) {
      const groups = t.readUInt32BE(12);
      for (let g = 0; g < groups; g++) if (cp >= t.readUInt32BE(16 + g * 12) && cp <= t.readUInt32BE(20 + g * 12)) return true;
    }
  }
  return false;
}

/** The code point a face must have: 'A' when its range takes it in (or it has none), else the first of its range. */
function probe(range) {
  if (!range) return 0x41;
  const spans = range.split(',').map((r) => r.trim().replace(/^U\+/i, '').split('-').map((h) => parseInt(h, 16)));
  return spans.some(([a, b = a]) => a <= 0x41 && 0x41 <= b) ? 0x41 : spans[0][0];
}

let bad = 0, faces = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
  for (const [face] of readFileSync(join(dir, f), 'utf8').matchAll(/@font-face\s*{[^}]*}/g)) {
    const src = face.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1];
    if (!src) continue;
    faces++;
    if (/^(https?:|\/\/)/.test(src)) { console.error(`${f}: ${src} is not ours; serve fonts from src/client/themes/fonts/`); bad++; continue; }
    const cp = probe(face.match(/unicode-range:\s*([^;}]+)/)?.[1]);
    const cmap = tables(readFileSync(join(dir, src))).get(0);
    if (!cmap || !maps(cmap, cp)) { console.error(`${f}: ${src} has no U+${cp.toString(16).toUpperCase().padStart(4, '0')}, which its @font-face is declared for`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(`theme fonts ok (${faces} faces)`);
