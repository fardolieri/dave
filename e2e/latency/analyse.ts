/**
 * The delay between the two channels of a recording (scripts/latency/rig.sh): left is what went into the speaking
 * friend's microphone, right what came out of the listening friend's speaker, both from one PulseAudio sink, so on one
 * clock. Slides a window over the speech and finds, for each, the lag where the right channel best matches the left:
 * first on the loudness envelope at 1 ms steps, then on the samples themselves around it.
 */
import { readFileSync } from 'node:fs';

export type Wav = { rate: number; left: Float32Array; right: Float32Array };

export function readWav(path: string): Wav {
  const b = readFileSync(path);
  let at = 12, rate = 0, channels = 0, bits = 0;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    let size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') { channels = b.readUInt16LE(at + 10); rate = b.readUInt32LE(at + 12); bits = b.readUInt16LE(at + 22); }
    if (id === 'data') {
      if (channels !== 2 || bits !== 16) throw new Error(`want 16-bit stereo, got ${channels} ch ${bits} bit`);
      // parecord writes a placeholder size when stopped by a signal: take what is there.
      if (size === 0 || size === 0xffffffff || at + 8 + size > b.length) size = b.length - at - 8;
      const n = Math.floor(size / 4);
      const left = new Float32Array(n), right = new Float32Array(n);
      for (let i = 0; i < n; i++) { left[i] = b.readInt16LE(at + 8 + i * 4) / 32768; right[i] = b.readInt16LE(at + 10 + i * 4) / 32768; }
      return { rate, left, right };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const envelope = (x: Float32Array, step: number): Float32Array => {
  const out = new Float32Array(Math.floor(x.length / step));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < step; j++) s += Math.abs(x[i * step + j]!); out[i] = s / step; }
  return out;
};

/** Normalised correlation of a[from, from+len) with b shifted by lag. */
function corr(a: Float32Array, b: Float32Array, from: number, len: number, lag: number): number {
  let sab = 0, saa = 0, sbb = 0, ma = 0, mb = 0;
  for (let i = 0; i < len; i++) { ma += a[from + i]!; mb += b[from + i + lag]!; }
  ma /= len; mb /= len;
  for (let i = 0; i < len; i++) { const x = a[from + i]! - ma, y = b[from + i + lag]! - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

export type Window = { atS: number; lagMs: number; envCorr: number; sampleCorr: number };

export function delays(w: Wav, opts: { windowS?: number; hopS?: number; maxLagMs?: number } = {}): Window[] {
  const windowS = opts.windowS ?? 3, hopS = opts.hopS ?? 1, maxLag = opts.maxLagMs ?? 1500;
  const step = w.rate / 1000; // 1 ms
  const el = envelope(w.left, step), er = envelope(w.right, step);
  const len = windowS * 1000;
  const out: Window[] = [];
  const loud = (e: Float32Array, from: number) => { let s = 0; for (let i = 0; i < len; i++) s += e[from + i]!; return s / len; };
  for (let from = 0; from + len + maxLag < el.length; from += hopS * 1000) {
    if (loud(el, from) < 0.003) continue; // a pause in the speech: nothing to match
    let best = -1, bestLag = 0;
    for (let lag = 0; lag <= maxLag; lag++) { const c = corr(el, er, from, len, lag); if (c > best) { best = c; bestLag = lag; } }
    if (best < 0.5) { out.push({ atS: from / 1000, lagMs: NaN, envCorr: best, sampleCorr: NaN }); continue; }
    // Refine on the samples within ±3 ms (the codec keeps the waveform closely enough at speech rates).
    const s0 = from * step, sl = len * step;
    let bs = -1, bsLag = bestLag * step;
    for (let lag = Math.max(0, (bestLag - 3) * step); lag <= (bestLag + 3) * step; lag += 2) {
      if (s0 + sl + lag > w.right.length) break;
      const c = corr(w.left, w.right, s0, sl, lag);
      if (c > bs) { bs = c; bsLag = lag; }
    }
    out.push({ atS: from / 1000, lagMs: bs > 0.3 ? bsLag / step : bestLag, envCorr: best, sampleCorr: bs });
  }
  return out;
}

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
export function summary(ws: Window[]) {
  const lags = ws.map((w) => w.lagMs).filter((x) => Number.isFinite(x));
  const third = Math.floor(lags.length / 3);
  return {
    windows: ws.length, matched: lags.length,
    medianMs: Math.round(q(lags, 0.5)), p10Ms: Math.round(q(lags, 0.1)), p90Ms: Math.round(q(lags, 0.9)),
    minMs: Math.round(Math.min(...lags)), maxMs: Math.round(Math.max(...lags)),
    firstThirdMs: Math.round(q(lags.slice(0, third), 0.5)), lastThirdMs: Math.round(q(lags.slice(-third), 0.5)),
  };
}
