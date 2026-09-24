#!/usr/bin/env node
// Models every emoji's join cue as the browser renders it (ticket 23): the tone's harmonics (a PeriodicWave is
// normalised to peak 1), the pitch-tracking low-pass, then A-weighting for how loud the ear finds each frequency.
// Prints the loudness spread by tone and by register, and the melodic shape. dB values are relative; only spreads
// matter. Development aid: `node scripts/cue-model.mjs`. TIMBRE_GAIN in core/cue.ts was set from the "gain to
// match sine" line of a run with every tone at gain 1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'cue-model-'));
writeFileSync(join(dir, 'entry.ts'), `export { joinCue, TIMBRES, noteGain } from '${process.cwd()}/src/core/cue';\nexport { EMOJI_CATEGORIES } from '${process.cwd()}/src/core/emoji';\nexport { cutoffFor } from '${process.cwd()}/src/client/sound';\n`);
execFileSync('pnpm', ['exec', 'esbuild', join(dir, 'entry.ts'), '--bundle', '--format=esm', '--log-level=error', `--outfile=${join(dir, 'cue.mjs')}`], { stdio: 'inherit' });
const { joinCue, TIMBRES, EMOJI_CATEGORIES, noteGain, cutoffFor } = await import(pathToFileURL(join(dir, 'cue.mjs')).href);
rmSync(dir, { recursive: true, force: true });

const PI = Math.PI;
function harmonics(timbre) {
  const t = TIMBRES[timbre];
  let a = [];
  if (t === 'sine') a = [1];
  else if (t === 'triangle') for (let k = 1; k <= 40; k += 2) a[k - 1] = 8 / (PI * PI) / (k * k);
  else if (t === 'square') for (let k = 1; k <= 40; k += 2) a[k - 1] = 4 / PI / k;
  else if (t === 'sawtooth') for (let k = 1; k <= 40; k++) a[k - 1] = 2 / PI / k;
  else a = [...t];
  a = a.map((x) => x ?? 0);
  let peak = 0;
  for (let i = 0; i < 2048; i++) { const th = (2 * PI * i) / 2048; let v = 0; a.forEach((x, k) => { v += x * Math.sin((k + 1) * th); }); peak = Math.max(peak, Math.abs(v)); }
  return a.map((x) => x / peak);
}
const aWeight = (f) => { const f2 = f * f; const r = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)); return r * 10 ** (2 / 20); };
// Web Audio's lowpass takes Q in dB; the default 1 dB is close to Butterworth.
const lowpass = (f, fc, qDb = 1) => { const q = 10 ** (qDb / 20); const x = f / fc; return 1 / Math.sqrt((1 - x * x) ** 2 + (x / q) ** 2); };
const H = Object.fromEntries(Object.keys(TIMBRES).map((t) => [t, harmonics(t)]));
const voicePower = (timbre, freq, gain) => H[timbre].reduce((p, a, k) => { const f = (k + 1) * freq; const amp = gain * a * lowpass(f, cutoffFor(freq)) * aWeight(f); return p + amp * amp; }, 0);
const dB = (p) => 10 * Math.log10(p);
function loudness(cue) {
  let p = 0, d = 0;
  for (const n of cue.notes) {
    const g = noteGain(cue, n);
    p += (n.with ? voicePower(cue.timbre, n.freq, g * 0.85) + voicePower(cue.timbre, n.with, g * 0.6) : voicePower(cue.timbre, n.freq, g)) * n.seconds;
    d += n.seconds;
  }
  return dB(p / d);
}
const all = EMOJI_CATEGORIES.flatMap((c) => c.entries.map((e) => e.char));
const rows = all.map((e) => { const j = joinCue(e); const f = j.notes.map((n) => n.freq); return { e, j, loud: loudness(j), lo: Math.min(...f), falls: f.at(-1) < f[0], leap: Math.max(...f.map((x, i) => (i ? Math.abs(12 * Math.log2(x / f[i - 1])) : 0))) }; });
const stats = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); return `mean ${m.toFixed(1)} sd ${sd.toFixed(1)} min ${Math.min(...xs).toFixed(1)} max ${Math.max(...xs).toFixed(1)}`; };
const raw = Object.keys(TIMBRES).map((t) => { const rs = rows.filter((r) => r.j.timbre === t); return [t, rs.reduce((a, r) => a + r.loud - 20 * Math.log10(r.j.gain / 0.08), 0) / rs.length]; });
console.log('gain to match sine, with per-tone gains removed:', raw.map(([t, m]) => `${t} ${(10 ** ((raw[0][1] - m) / 20)).toFixed(2)}`).join(', '));
console.log('loudness, all cues:', stats(rows.map((r) => r.loud)));
for (const t of Object.keys(TIMBRES)) console.log(`  ${t.padEnd(9)}`, stats(rows.filter((r) => r.j.timbre === t).map((r) => r.loud)));
for (const [a, b] of [[0, 300], [300, 450], [450, 650], [650, 2000]]) { const rs = rows.filter((r) => r.lo >= a && r.lo < b); console.log(`  lowest note ${a}-${b} Hz`.padEnd(28), stats(rs.map((r) => r.loud)), `(${rs.length} cues)`); }
console.log('join ends lower than it starts:', `${(100 * rows.filter((r) => r.falls).length / rows.length).toFixed(0)}%`);
console.log('largest leap > 9 semitones:', `${(100 * rows.filter((r) => r.leap > 9).length / rows.length).toFixed(0)}%`, ' > 12:', `${(100 * rows.filter((r) => r.leap > 12).length / rows.length).toFixed(0)}%`);
console.log('two notes:', `${(100 * rows.filter((r) => r.j.notes.length === 2).length / rows.length).toFixed(0)}%`, ' with a second voice:', `${(100 * rows.filter((r) => r.j.notes.some((n) => n.with)).length / rows.length).toFixed(0)}%`);
console.log('distinct cues:', new Set(rows.map((r) => JSON.stringify(r.j))).size, 'of', rows.length);
