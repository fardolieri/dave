#!/usr/bin/env node
// Tallies the picks the "Dave Cue Picks" page saves (ticket 23): win rate of every knob value over the pairs that
// differed in it, plus the single-knob pairs on their own. `node scripts/cue-picks.mjs <dir of pick JSON> [round]`
// with the JSON as the ArtifactData tool exports it; without a round, every round is pooled. Each round sampled the
// knob ranges the app shipped at the time, so a pick is decoded with its own round's labels (a pick without a round
// is round 1).
import { readdirSync, readFileSync } from 'node:fs';
const [dir, roundArg] = process.argv.slice(2);
if (!dir) { console.error('usage: cue-picks.mjs <dir> [round]'); process.exit(2); }
const only = roundArg ? Number(roundArg) : null;
const picks = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))).filter((p) => only === null || (p.round ?? 1) === only).sort((a, b) => a.at.localeCompare(b.at));
const rounds = [...new Set(picks.map((p) => p.round ?? 1))].sort();
console.log(`${only ? `round ${only}` : `rounds ${rounds.join(', ')} pooled`}: ${picks.length} picks, ${picks.filter((p) => p.choice === 'tie').length} ties, ${picks.filter((p) => p.differs !== 'all').length} single-knob pairs`);
const ROUNDS = {
  1: { TIMBRE: ['sine', 'triangle', 'square', 'sawtooth', 'organ', 'bell', 'reed', 'glass'], REG: ['C4', 'D4', 'F4', 'G4'], REGST: [0, 2, 5, 7], RHY: [[1, 1, 1], [1, 1, 2], [2, 1, 1], [1, 2, 1]], STEP: [80, 100, 130] },
  2: { TIMBRE: ['sine', 'sine', 'triangle', 'triangle', 'glass', 'organ', 'square', 'reed'], REG: ['C4', 'D4', 'E♭4', 'F4'], REGST: [0, 2, 3, 5], RHY: [[1, 1, 1], [1, 1, 2], [2, 1, 1], [1, 2, 1], [1, 1, 3], [2, 2, 1], [1, 2, 2], [2, 1, 2]], STEP: [65, 80, 100] },
  3: { TIMBRE: ['sine', 'sine', 'sine', 'triangle', 'triangle', 'triangle', 'glass', 'organ'], REG: ['C4', 'D4', 'E♭4', 'F4'], REGST: [0, 2, 3, 5], RHY: [[1, 1, 1], [1, 1, 2], [2, 1, 1], [1, 2, 1]], STEP: [55, 70, 85] },
};
const DYAD = ['none', 'third on last', 'fifth on last', 'fifths throughout'];
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
function steps(p, round) {
  if (round === 1) {
    let s = p.offsets.map((o) => p.base + o);
    if (p.count === 2) s = [s[0], s[2]];
    const end = s.length - 1;
    if (s.every((x) => x === s[0])) s[end] = s[end] + (s[end] >= p.base + 3 ? -2 : 2);
    if (s[end] < s[0]) [s[0], s[end]] = [s[end], s[0]];
    return s;
  }
  let o = p.count === 2 ? [p.offsets[0], p.offsets[2]] : [...p.offsets]; // core/cue.ts melodySteps of that round
  const end = o.length - 1;
  const lo = Math.min(...o), hi = Math.max(...o);
  if (hi === lo) o[end] = lo + 2 <= 3 ? lo + 2 : lo - 2;
  else if (hi - lo < 2) o = lo + 2 <= 3 ? o.map((x) => (x === hi ? lo + 2 : x)) : o.map((x) => (x === lo ? hi - 2 : x));
  if (o[end] < o[0]) [o[0], o[end]] = [o[end], o[0]];
  if (round >= 3 && end === 2 && o[1] > o[2]) [o[1], o[2]] = [o[2], o[1]];
  return o.map((x) => p.base + x);
}
function shape(s) {
  if (s.length === 2) return 'two: rising';
  const [a, b, c] = s;
  if (b > c) return 'arch (up then down)';
  if (b < a) return 'dip (down then up)';
  if (a === b || b === c) return 'step with a repeat';
  return 'straight up';
}
function features(p, round) {
  const K = ROUNDS[round];
  const s = steps(p, round);
  const rhythm = K.RHY[p.rhythm].slice(0, p.count);
  const ms = K.STEP[p.stepSeconds];
  const total = rhythm.reduce((a, b) => a + b, 0) * ms;
  const lo = SCALE[Math.min(...s)] + K.REGST[p.register], hi = SCALE[Math.max(...s)] + K.REGST[p.register];
  return {
    tone: K.TIMBRE[p.timbre], register: K.REG[p.register], rhythm: rhythm.map((r) => ['short', 'long', 'longer'][r - 1]).join('-'),
    dyad: DYAD[p.dyad], 'second voice': p.dyad ? 'yes' : 'no', notes: `${p.count}`, 'step ms': `${ms}`,
    shape: shape(s), 'span st': `${SCALE[Math.max(...s)] - SCALE[Math.min(...s)]}`,
    'lowest note': lo < 5 ? 'C4-E4' : lo < 10 ? 'F4-A4' : 'B4 and up', 'highest note': hi < 9 ? 'up to G4' : hi < 14 ? 'A4-C5' : 'D5 and up',
    'length ms': total < 200 ? 'under 200' : total < 280 ? '200-279' : total < 340 ? '280-339' : '340 and over',
  };
}
const tally = {};
const add = (feat, val, r) => { tally[feat] ??= {}; tally[feat][val] ??= { w: 0, l: 0, t: 0 }; tally[feat][val][r]++; };
for (const p of picks) {
  const round = p.round ?? 1;
  const fa = features(p.a, round), fb = features(p.b, round);
  for (const feat of Object.keys(fa)) {
    if (fa[feat] === fb[feat]) continue;
    if (p.choice === 'tie') { add(feat, fa[feat], 't'); add(feat, fb[feat], 't'); continue; }
    const [win, lose] = p.choice === 'a' ? [fa[feat], fb[feat]] : [fb[feat], fa[feat]];
    add(feat, win, 'w'); add(feat, lose, 'l');
  }
}
for (const feat of Object.keys(tally)) {
  const vals = Object.entries(tally[feat]).sort((a, b) => b[1].w / (b[1].w + b[1].l || 1) - a[1].w / (a[1].w + a[1].l || 1));
  console.log(`\n${feat}  (win rate over pairs that differ here; n = decided pairs)`);
  for (const [v, r] of vals) {
    const n = r.w + r.l;
    const rate = n ? (100 * r.w / n).toFixed(0) : '-';
    const bar = n ? '█'.repeat(Math.round(r.w / n * 20)).padEnd(20, '·') : ''.padEnd(20);
    console.log(`  ${v.padEnd(22)} ${bar} ${String(rate).padStart(3)}%  ${r.w}-${r.l}${r.t ? `, ${r.t} ties` : ''}`);
  }
}
const KNOB_OF = { timbre: 'tone', register: 'register', rhythm: 'rhythm', dyad: 'dyad', count: 'notes', stepSeconds: 'step ms', melody: null };
console.log('\nSingle-knob pairs only (wins-losses-ties per value):');
for (const knob of Object.keys(KNOB_OF)) {
  const ps = picks.filter((p) => p.differs === knob);
  const feat = KNOB_OF[knob];
  if (!feat) { console.log(`  melody: ${ps.length} pairs, ties ${ps.filter((p) => p.choice === 'tie').length}`); continue; }
  const t = {};
  for (const p of ps) {
    const round = p.round ?? 1;
    const va = features(p.a, round)[feat], vb = features(p.b, round)[feat];
    t[va] ??= { w: 0, l: 0, t: 0 }; t[vb] ??= { w: 0, l: 0, t: 0 };
    if (p.choice === 'tie') { t[va].t++; t[vb].t++; } else { const [w, l] = p.choice === 'a' ? [va, vb] : [vb, va]; t[w].w++; t[l].l++; }
  }
  console.log(`  ${knob} (${ps.length} pairs): ${Object.entries(t).map(([v, r]) => `${v} ${r.w}-${r.l}${r.t ? `-${r.t}t` : ''}`).join(' | ')}`);
}
