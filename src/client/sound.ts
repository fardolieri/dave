import { noteGain, type Cue } from '../core/cue';
import { restartOnFailure, type ContextStarter } from './audiofailure';
import posthog from './posthog';

// The one AudioContext for cues (spec §7.4). Browsers only let audio start after a gesture, so the context is created
// lazily on first interaction. The unlock listens for `click`, not `pointerdown`, and unregisters once the context
// runs. Brave with autoplay set to Block clears the page's user activation whenever the autoplay policy is consulted,
// and creating or resuming an AudioContext consults it: an unlock on pointerdown robbed the click handler that
// followed, a share tile's play(), of the gesture it needs, and the tile stayed black (reproduced in headless Brave,
// Sep 10).
let ctx: AudioContext | null = null;
let restart: ContextStarter | null = null;

// A running context keeps the audio device and the browser's audio renderer at work while it plays nothing: about 9 %
// of a core on the dev box, from the first click on (2026-11-26). So it sleeps (suspend()) once nothing has sounded for
// a while, and the next sound wakes it (resume(), allowed without a gesture once the page has had one). A sound
// scheduled while it sleeps waits on its stopped clock and plays as it wakes, its notes still in step.
/** How long after the last sound ends, or after it starts running, the context goes to sleep. */
const SLEEP_AFTER_MS = 5_000;
/** A wake that has not made it run by then is given up: the next click starts it, as the first one did. */
const WAKE_WAIT_MS = 2_000;
/** Asleep by our own suspend(), not stopped by the browser or a failed device. */
let asleep = false;
/** Woken by our own resume(), which has not made it run yet: its state still says suspended a while. */
let waking = false;
let sleepTimer: ReturnType<typeof setTimeout> | undefined;
let busyUntil = 0;

function sleepLater(ms: number): void {
  busyUntil = Math.max(busyUntil, Date.now() + ms);
  clearTimeout(sleepTimer);
  const c = ctx;
  sleepTimer = setTimeout(() => {
    if (ctx !== c || !c || c.state !== 'running') return;
    asleep = true;
    void c.suspend().catch(() => {});
  }, busyUntil - Date.now());
}

/**
 * Wakes the context from its sleep. Whatever its state says: Firefox and Safari say running a while after suspend(), and
 * a resume() after it undoes it. Should it not run in time, a browser that refused it without a gesture, the next click
 * starts it as the first did, and what waits on its clock plays then.
 */
function wake(c: AudioContext): void {
  asleep = false;
  waking = true;
  /** Why resume() failed, if it did: a refusal tells itself from a wake that is only slow (still pending). */
  let refused: string | null = null;
  void c.resume().catch((e: unknown) => { refused = (e as { name?: unknown } | null)?.name === undefined ? 'error' : String((e as { name: unknown }).name); });
  setTimeout(() => {
    if (ctx !== c || !waking || c.state === 'running') return;
    waking = false;
    console.warn('[audio] the cues\' AudioContext did not wake from its sleep; a click starts it again');
    posthog.capture('cue_wake_refused', { state: c.state, refused });
    startUnlocking();
  }, WAKE_WAIT_MS);
}

/**
 * The cues' context to schedule a sound on, woken if it sleeps; null while no gesture has unlocked it. `seconds`: how
 * long the sound lasts, so the context stays awake through it. Every sound until it runs again waits on its stopped
 * clock beside the first, a fanfare's notes and two friends' cues alike.
 */
export function cueAudio(seconds: number): AudioContext | null {
  const c = ctx;
  if (!c) return null;
  if (asleep) wake(c);
  else if (!waking && c.state !== 'running') return null;
  sleepLater(seconds * 1000 + SLEEP_AFTER_MS);
  return c;
}

/** The cues' context's state, for the inspection hooks: `asleep` when it sleeps between sounds. */
export const cueState = (): AudioContextState | 'asleep' | null => (ctx && asleep && ctx.state === 'suspended' ? 'asleep' : ctx?.state ?? null);

const stopUnlocking = () => { window.removeEventListener('click', unlock); window.removeEventListener('keydown', unlock); };
const startUnlocking = () => { window.addEventListener('click', unlock); window.addEventListener('keydown', unlock); };
function unlock(): void {
  if (!ctx) {
    const c = (ctx = new AudioContext());
    // Given up after the audio device failed again and again: the next gesture starts it, as it did the first time.
    restart = restartOnFailure(c, 'cues', () => { if (ctx === c) startUnlocking(); });
    c.addEventListener('statechange', () => {
      if (ctx !== c || c.state !== 'running') return;
      asleep = false;
      waking = false;
      stopUnlocking();
      sleepLater(SLEEP_AFTER_MS);
    });
    // A device failure stops it whether or not it slept: from then on it is the failure's to start again (audiofailure.ts).
    c.addEventListener('error', () => { if (ctx === c) { asleep = false; waking = false; } });
  }
  // Asleep (a Rejoin's try, after a quiet spell): woken as a sound would wake it, which arms the click again should it fail.
  if (asleep) { wake(ctx); return; }
  if (ctx.state === 'running') { stopUnlocking(); return; }
  restart?.startAgain();
}

/**
 * Tries to unlock without a gesture, for a Rejoin: once the page holds the microphone, Chromium and Firefox let the
 * context run. If it stays suspended, the click unlock still waits. No gesture exists here for Brave to take.
 */
export function tryUnlockSound(): void { unlock(); }

/** Starts listening for the gesture that unlocks audio; the returned function stops everything. */
export function armSound(): () => void {
  startUnlocking();
  return () => { stopUnlocking(); clearTimeout(sleepTimer); asleep = false; waking = false; void ctx?.close(); ctx = null; };
}

/** The cues' context, for the inspection hooks; null until the first unlock. */
export const cueContext = (): AudioContext | null => ctx;

/** The low-pass cutoff for a note: follows the pitch, so a square at C4 and one at A5 keep the same overtones and a low note does not buzz; on the soft side, since soft tones won the picks. */
const cutoffFor = (freq: number): number => Math.min(5000, Math.max(1000, freq * 4));

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
  const c = cueAudio(cueSeconds(cue));
  if (c) scheduleCue(c, cue, c.currentTime);
}

/** How long a cue sounds, its last note's ring-out included (as scheduleCue builds it). */
function cueSeconds(cue: Cue): number {
  const notes = cue.notes.reduce((s, n) => s + n.seconds, 0);
  const last = cue.notes[cue.notes.length - 1];
  return notes + (last ? Math.max(last.seconds, 0.18) * 0.6 * 5 : 0);
}
