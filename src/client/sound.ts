import { TIMBRES, noteGain, type Cue } from '../core/cue';

// The one AudioContext for cues (spec §7.4). Browsers only let audio start after a gesture, so the context is created
// lazily on first interaction. The unlock listens for `click`, not `pointerdown`, and unregisters once the context
// runs. Brave with autoplay set to Block clears the page's user activation whenever the autoplay policy is consulted,
// and creating or resuming an AudioContext consults it: an unlock on pointerdown robbed the click handler that
// followed, a share tile's play(), of the gesture it needs, and the tile stayed black (reproduced in headless Brave,
// Sep 10).
let ctx: AudioContext | null = null;

const stopUnlocking = () => { window.removeEventListener('click', unlock); window.removeEventListener('keydown', unlock); };
function unlock(): void {
  ctx ??= new AudioContext();
  if (ctx.state === 'running') { stopUnlocking(); return; }
  ctx.resume().then(() => { if (ctx?.state === 'running') stopUnlocking(); }, () => {});
}

/** Starts listening for the gesture that unlocks audio; the returned function stops everything. */
export function armSound(): () => void {
  window.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock);
  return () => { stopUnlocking(); void ctx?.close(); ctx = null; };
}

/** The low-pass cutoff for a note: follows the pitch, so a square at C4 and one at A5 keep the same overtones and a low note does not buzz; on the soft side, since soft tones won the picks. */
export const cutoffFor = (freq: number): number => Math.min(5000, Math.max(1000, freq * 4));

/**
 * Builds the graph for one cue starting at `t0` and returns its oscillators. Every note is a struck chime: an 8 ms
 * attack, then an exponential fade that runs on a little under the next note, and the last note rings out briefly,
 * with the cue's wobble on it. A dyad's second voice shares the envelope, both voices turned down so the pair is
 * about as loud as one note.
 */
export function scheduleCue(c: AudioContext, cue: Cue, t0: number): OscillatorNode[] {
  let start = t0;
  const oscs: OscillatorNode[] = [];
  cue.notes.forEach((note, i) => {
    const last = i === cue.notes.length - 1;
    const decay = last ? Math.max(note.seconds, 0.18) * 0.6 : note.seconds * 0.45; // time constant: -8.7 dB per constant; a short ring-out
    const stop = start + note.seconds + decay * 5; // faded below -40 dB by then
    const voices: [number, number][] = note.with ? [[note.freq, 0.85], [note.with, 0.6]] : [[note.freq, 1]];
    for (const [freq, level] of voices) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      const filter = c.createBiquadFilter();
      osc.type = TIMBRES[cue.timbre];
      osc.frequency.value = freq;
      if (last && cue.vibrato > 0) {
        const lfo = c.createOscillator();
        const depth = c.createGain();
        lfo.frequency.value = 5;
        depth.gain.value = freq * 0.012 * cue.vibrato;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(start + note.seconds * 0.4);
        lfo.stop(stop);
        oscs.push(lfo);
      }
      filter.type = 'lowpass';
      filter.frequency.value = cutoffFor(freq);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(noteGain(cue, note) * level, start + 0.008);
      gain.gain.setTargetAtTime(0, start + 0.008, decay);
      osc.connect(gain).connect(filter).connect(c.destination);
      osc.start(start);
      osc.stop(stop);
      oscs.push(osc);
    }
    start += note.seconds;
  });
  return oscs;
}

/** Plays a cue; several friends arriving at once simply overlap. Silent until a gesture has unlocked audio. */
export function playCue(cue: Cue): void {
  const c = ctx;
  if (c?.state === 'running') scheduleCue(c, cue, c.currentTime);
}
