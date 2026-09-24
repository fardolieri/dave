// Join and leave cues per friend (spec §7.4, ticket 23): plain rules, no DOM, so they can be unit-tested.
// The profile picture is the sound. Nothing is chosen or sent apart from the emoji: every browser derives the same
// cue from it, and a friend who does not like how theirs sounds picks another emoji.

/**
 * The tones a cue can have. Over three rounds of blind picks (274 pairs) sine won 29-1 and beat triangle head to head;
 * triangle, square, sawtooth and every overtone mix (organ, bell, reed, glass) lost and are gone. The knob stays, in
 * case a tone ever earns its way back.
 */
export const TIMBRES = { sine: 'sine' } as const satisfies Record<string, 'sine'>; // core is runtime-neutral, so no OscillatorType here
export type Timbre = keyof typeof TIMBRES;
/** One note, with an optional second voice sounding at the same time (a dyad). */
export type Note = { freq: number; seconds: number; with?: number };
/** `vibrato` is the depth of a slow wobble on the last note, 0 (none) to 1 (about a fifth of a semitone). */
export type Cue = { timbre: Timbre; gain: number; notes: Note[]; vibrato: number };

/** Loudness of a cue; the message tick is softer. */
export const CUE_GAIN = 0.08;
export const MESSAGE_GAIN = 0.05;
export const STEP_SECONDS = 0.06;
const C4 = 261.63;

export const TIMBRE_NAMES = Object.keys(TIMBRES) as Timbre[];
/** What the hash draws from. */
export const TIMBRE_POOL: Timbre[] = ['sine'];
/**
 * Evens the tones out: at the same gain a sine sounds much louder than a low-passed square. From a model of the
 * rendering (harmonics, the pitch-tracking low-pass, A-weighting; see the ticket), sine being the reference.
 */
const TIMBRE_GAIN: Record<Timbre, number> = { sine: 1 };
/** Major pentatonic over an octave and a half, in semitones: no two notes clash, so every melody sounds pleasant. */
export const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
/** Its wistful sister, the minor pentatonic: the mood knob, half the emoji. */
export const MINOR_SCALE = [0, 3, 5, 7, 10, 12, 15, 17];
export const MOODS = ['bright', 'moody'] as const;
export type Mood = (typeof MOODS)[number];
export const scaleFor = (mood: Mood): readonly number[] => (mood === 'moody' ? MINOR_SCALE : SCALE);
/** Vibrato depths the hash draws from: none, and three steps up to the lab's "slow" wobble. */
export const VIBRATOS = [0, 1 / 3, 2 / 3, 1];
/** Transpositions of the whole melody, in semitones; the lowest note is never below C4. */
export const REGISTERS = [0, 2, 3, 5];
/** The highest note, in semitones above C4: C5. Tunes reaching D5 and above lost every round of picks. */
export const TOP = 12;
/**
 * Note lengths in steps, by note count, weighted as the picks went: short-long won for two notes (17-8), long-short-short
 * (17-11) led for three, short-long-short lost (5-17) and is gone. Cues over 340 ms lost, so none is longer than four steps.
 */
export const RHYTHMS: Record<2 | 3, number[][]> = { 2: [[1, 2], [1, 2], [1, 2], [1, 1]], 3: [[2, 1, 1], [2, 1, 1], [1, 1, 2], [1, 1, 1]] };
/**
 * Harmony: single notes (a quarter of the emoji); a second voice under the last note two scale steps up (a third or a
 * fourth; three eighths) or three up (a fifth or a sixth; a quarter); or that fifth under every note (an eighth).
 * Partners stay on the scale, so every dyad is consonant. A voice on the last note won both rounds of picks.
 */
export const DYADS = ['none', 'third on last', 'fifth on last', 'fifths throughout'] as const;

const semitones = (n: number) => C4 * 2 ** (n / 12);

/** A friend without a picture keeps the plain chime: two notes rising. */
const PLAIN: Cue = { timbre: 'sine', gain: CUE_GAIN, notes: [523.25, 659.25].map((freq) => ({ freq, seconds: STEP_SECONDS })), vibrato: 0 };
/** Someone else's message: one soft high note, the same for everyone. */
export const MESSAGE_CUE: Cue = { timbre: 'sine', gain: MESSAGE_GAIN, notes: [{ freq: 880, seconds: STEP_SECONDS }], vibrato: 0 };

/** FNV-1a over the UTF-16 units, then a finaliser so neighbouring code points land far apart. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The scale steps of a tune from a base step and offsets of 0..3 (four neighbouring steps, at most eight semitones):
 * two notes keep the first and last offset; the tune spans at least two steps (a third or more), ends higher than it
 * starts and never arches (a middle note above the last lost the picks: it is swapped with the last).
 */
export function melodySteps(base: number, offsets: number[], count: 2 | 3): number[] {
  let o = count === 2 ? [offsets[0]!, offsets[2]!] : [...offsets];
  const end = o.length - 1;
  const lo = Math.min(...o), hi = Math.max(...o);
  if (hi === lo) o[end] = lo + 2 <= 3 ? lo + 2 : lo - 2; // one note over and over is a rhythm, not a tune
  else if (hi - lo < 2) o = lo + 2 <= 3 ? o.map((x) => (x === hi ? lo + 2 : x)) : o.map((x) => (x === lo ? hi - 2 : x)); // too narrow: stretch
  if (o[end]! < o[0]!) [o[0], o[end]] = [o[end]!, o[0]!];
  if (end === 2 && o[1]! > o[2]!) [o[1], o[2]] = [o[2]!, o[1]!];
  return o.map((x) => base + x);
}

/** The knobs one cue is built from: scale steps (indices into the mood's scale), a register, a rhythm, a tone, a mood and a wobble. */
export type CueParts = { timbre: Timbre; steps: number[]; register: number; rhythm: readonly number[]; dyad: number; mood: Mood; vibrato: number; stepSeconds?: number };

export function buildCue(p: CueParts): Cue {
  const step = p.stepSeconds ?? STEP_SECONDS;
  const scale = scaleFor(p.mood);
  return {
    timbre: p.timbre,
    gain: CUE_GAIN * TIMBRE_GAIN[p.timbre],
    vibrato: p.vibrato,
    notes: p.steps.map((s, i) => {
      const note: Note = { freq: semitones(scale[s]! + p.register), seconds: p.rhythm[i]! * step };
      const last = i === p.steps.length - 1;
      if (p.dyad === 3 || (last && p.dyad > 0)) {
        const up = p.dyad === 1 ? 2 : 3;
        note.with = semitones(scale[s + up < scale.length ? s + up : s - up]! + p.register); // above when the scale has room, else below
      }
      return note;
    }),
  };
}

/**
 * The knobs a friend's arrival plays with, all from the emoji's hash, so no group of emoji shares a tone. The two or
 * three notes follow `melodySteps`, and the tune ends higher than it starts: arriving rises, and the leave, played
 * backwards, falls.
 */
export function joinParts(picture: string): CueParts {
  // Mixed-radix digits of the hash, so a five-way choice is as even as a two-way one (bit fields would skew it).
  let h = hash(picture);
  const take = (n: number) => { const v = h % n; h = Math.floor(h / n); return v; };
  const base = take(3); // the top of the window stays at C5 or below
  const count: 2 | 3 = take(2) === 0 ? 2 : 3; // half the emoji get two notes; two and three came out even over the rounds
  const steps = melodySteps(base, [take(4), take(4), take(4)], count);
  const mood = MOODS[take(2)]!;
  const fits = REGISTERS.filter((r) => scaleFor(mood)[Math.max(...steps)]! + r <= TOP); // never empty: the base keeps register 0 in
  const dyad = [0, 0, 1, 1, 1, 2, 2, 3][take(8)]!;
  return { steps, register: fits[take(4) % fits.length]!, rhythm: RHYTHMS[count][take(4)]!, timbre: TIMBRE_POOL[take(TIMBRE_POOL.length)]!, dyad, mood, vibrato: VIBRATOS[take(4)]! };
}

/** The cue a friend's arrival plays. */
export function joinCue(picture: string | null | undefined): Cue {
  return picture ? buildCue(joinParts(picture)) : PLAIN;
}

/** The same friend leaving: their cue backwards, a fourth lower, slower and a little quieter. */
export function leaveCue(picture: string | null | undefined): Cue {
  const join = joinCue(picture);
  return { timbre: join.timbre, gain: join.gain * 0.8, vibrato: join.vibrato, notes: [...join.notes].reverse().map((n) => ({ freq: n.freq * 2 ** (-5 / 12), seconds: n.seconds * 1.2, ...(n.with ? { with: n.with * 2 ** (-5 / 12) } : {}) })) };
}

/**
 * The gain one note is played at: the cue's, raised for low notes, which the ear finds quieter (roughly the 40-phon
 * equal-loudness curve over this range, taken halfway so small speakers are not pushed into bass they cannot play).
 */
export const noteGain = (cue: Cue, note: Note): number => cue.gain * (440 / note.freq) ** 0.5;
