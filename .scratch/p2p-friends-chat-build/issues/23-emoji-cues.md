# 23 · Join and leave cues from the profile picture

Status: built 2026-09-24, knobs settled after 274 blind picks; on build/23-emoji-cues, not merged
Asked for 2026-09-24: "I want to be able to tell who joins and leaves the channel without looking. I want the audio cue
to be enough to know who it was." Knobs were discussed and dropped: "I want to keep it simple and not overloaded...
there are enough emojis to pick from. If one doesn't sound good for you just pick another one." Overlapping cues are
fine: "do whatever is simpler code wise". And your own: "when I join or leave I want to hear my own sound cues as
well. A user should be aware of their own sound".

## Built
- `core/cue.ts`: `joinCue(picture)` derives three notes from the emoji. The notes come from a major pentatonic over an
  octave and a half, so every combination sounds pleasant. The register (4), rhythm (4) and notes all come from a hash
  of the emoji, and the wave from its picker category: faces and people sine, nature and food triangle, activities and
  travel square, objects and symbols sawtooth. Pasted emoji outside the list get a wave from the hash. Skin tones keep
  the category. One note three times is bumped to a tune. `leaveCue` plays the same notes backwards, a fourth lower,
  1.2 times slower and at 0.8 of the gain. A friend without a picture keeps the plain two-note chime. 1065 of the
  picker's 1082 emoji get a cue of their own.
- Nothing new on the wire: every browser derives the cue from the picture presence already carries.
- `client/sound.ts`: the AudioContext and its click/keydown unlock, moved out of `attention.ts` unchanged (the Brave
  note stays with it). `playCue` for the chimes, where cues from friends arriving together overlap. `previewCue`
  cuts off the preview still sounding. A 2.8 kHz low-pass keeps square and sawtooth soft.
- `client/attention.ts`: every join and leave plays that friend's cue. A leaver's picture comes from the previous
  presence snapshot. My own join and leave play my own cue, read from the call's `inCall` and not from presence, so a
  server reconnect (which keeps me in the call) plays nothing.
- Profile picture picker: an emoji previews when the pointer rests on it for 250 ms or it takes focus. Picking one
  that was not tried plays it, so a tap on a phone is heard too. The composer's picker stays silent.
- Profile card: a Sound row with ▶ joins and ▶ leaves, for learning a friend's sound or hearing your own.
- `scripts/drive.mjs` `CUE_CHECK=1`: records the oscillators each page starts, seeds pictures 😀 🦊 💡 🎸, and
  prints what each browser heard on joins, on the last browser leaving, and from the card's play button.

## Verify
- `pnpm typecheck`, `pnpm test` (135), `pnpm build`.
- `CUE_CHECK=1 node scripts/drive.mjs --join http://localhost:5199 <secret> Alice Bob Carol` against `pnpm dev --port 5199`,
  2026-09-24: Alice (😀) heard `triangle 466, 415, 622` (Bob 🦊) then `sawtooth 330, 440, 330` (Carol 💡); Bob heard
  Carol's; Carol heard nothing. Carol leaving: Alice and Bob heard `sawtooth 247, 330, 247`. Bob's card played his join. After the own-cue change,
  each browser also heard its own join first (Alice `sine 698, 523, 311`), Carol heard her own leave and, on rejoining,
  her own join, which Alice heard too.

## Comments
2026-09-24, after trying it on the dev server: "the sound preview on hover is not good. lets just remove the preview
and also remove the text in the UI ... its fine if this is a hidden feature that people sometime find out about. Also
remove the 'Sound ▶ joins ▶ leaves'. and I think we need to randomize more so that certain wave functions are not
exclusive to some emoji group ... maybe we can also add more wave function".
- Picker previews, the profile card's Sound row and the hint's mention of sound are gone; `EmojiPicker.tsx`,
  `App.tsx` and `styles.css` are as before this ticket. `previewCue` went with them.
- The tone now comes from the hash too (3 bits), no longer from the category, so `cue.ts` no longer reads the emoji
  list. Eight tones: sine, triangle, square, sawtooth, and four overtone mixes played through a PeriodicWave
  (`organ`, `hollow`, `reed`, `glass`), each with a gain evened out by ear. Every picker category now spans all eight
  (unit test). Skin-tone variants now hash on their own and may sound different from the base emoji.
- `pnpm typecheck`, `pnpm test` (135). `CUE_CHECK=1` against `pnpm dev`: the same joins, leaves and own cues as above,
  now as `custom` oscillators (😀 hollow, 🦊 glass, 💡 hollow).
- The playground artifact "Dave Emoji Tunes" runs the same `cue.ts`, bundled with esbuild, and was updated with it.

2026-09-24, later: "take a look at all the different audios and find out what makes some better sounding than others.
Maybe we have to tweak the knobs a little bit more so that the majority of cues sound great", then "lets also try adding
dyads or intervals" and "maybe also try to do only 2 notes sometimes instead of 3", and the offer to pick the better of
two sounds on a page that saves the picks.
- `scripts/cue-model.mjs` models every cue as rendered (harmonics, low-pass, A-weighting). Before: a 16 dB loudness
  spread between cues, sawtooth and square 10 dB under sine, low cues 4 dB under high ones, 45 % of joins falling (so
  their leaves rose), 45 % with a leap over 9 semitones and 19 % over an octave, 0.3 s long. After: 3.7 dB spread, tones
  within 0.3 dB, flat across registers, no join falls, no leap over an octave.
- `core/cue.ts`: knobs from the hash's mixed-radix digits (bit fields skewed the five-way choices). Melody within five
  neighbouring scale steps, ending higher than it starts (first and last note swapped otherwise), so the leave falls.
  Two notes for a quarter of the emoji. Registers moved up to start at C4. A harmony knob (`DYADS`): half single notes,
  a quarter a third or fourth on the last note, an eighth a fifth or sixth there, an eighth fifths throughout; partners
  stay on the pentatonic. `TIMBRE_GAIN` from the model; `noteGain` raises low notes (half the 40-phon curve). `hollow`
  became `bell` (harmonics 1, 3, 6, 10). `buildCue(parts)` is the shared way to make a cue from knobs, used by the hash
  and by the picks page. Distinct cues: 1050 of 1082.
- `client/sound.ts`: `scheduleCue` is exported and pure in its context; every note is a struck chime (8 ms attack,
  exponential fade, the last note rings about 0.2 s), the low-pass per note follows the pitch (5x, 1.2 to 6 kHz) so a
  tone sounds the same in every register, and a dyad's second voice shares the envelope at 0.85 / 0.6 of the gain.
- Artifacts: "Dave Cue Picks" (https://claude.ai/artifact/UZMYxCPhohVNceBsXCRhgb) plays two random cues built with
  `buildCue`, half the pairs differing in one knob, and saves every pick (knobs of both, choice, which knob differed)
  to the artifact's store for analysis. "Dave Emoji Tunes" now plays through `scheduleCue`.
- `pnpm typecheck`, `pnpm test` (137), `CUE_CHECK=1` against `pnpm dev`: joins, own cues and the falling leave as
  expected; a dyad shows as two oscillators (😀 `sine 494, 494, 784, 988`).

2026-09-24, "I picked a 100". Daniel's 100 blind picks on the Cue Picks page (69 decided, 31 ties), tallied by
`scripts/cue-picks.mjs` over the JSON the ArtifactData tool exported. Win rate over pairs that differed in the feature:
- Tone, the strongest signal: sine 89 % (n=9), triangle 77 % (13), glass 64 % (11), organ 50 % (12), square 36 % (11),
  reed 33 % (9), bell 25 % (8), sawtooth 11 % (9). Single-knob pairs: sine > square, triangle > square.
- Span: 5 to 7 semitones 72 % (25), 8 to 10 semitones 26 % (19), 4 or less 44 % (18).
- Register: C4 67 % (24), F4 57 % (21), D4 39 % (18), G4 35 % (23).
- Step: 80 ms 64 % (22) and 3-0 in single-knob pairs, 130 ms 50 % (28) but 0-3 in single-knob pairs, 100 ms 36 % (22).
- Two notes 60 % vs three 40 % (25 each; 3-1 in single-knob pairs). A third on the last note 73 % (11); the other dyad
  settings and no dyad 43 to 50 %. Rhythm 41 to 65 %, the shape of the tune 41 to 60 %: noise at this size.
Applied: sawtooth and bell removed; the hash draws tones from `TIMBRE_POOL` (sine and triangle twice, glass, organ,
square, reed once). `melodySteps`: four neighbouring scale steps (at most eight semitones), at least two steps wide (a
third or more). Registers C4, D4, E♭4, F4. `STEP_SECONDS` 0.08. Two notes for three eighths of the emoji. Eight
rhythms instead of four, for variety. The low-pass follows the pitch at 4x (1 to 5 kHz) instead of 5x. Distinct
cues: 983 of 1082 (the test now asks for nine in ten; among a few friends in a call a shared cue stays a rare
coincidence). The Cue Picks page now samples these settings ("round two", picks carry `round: 2`) with steps of 65,
80 and 100 ms, for a second batch if wanted.

2026-09-24, "i did 101 new rounds. analyse". Round two: 103 picks, 65 ties (the cues had grown much closer), 38 decided.
- Tone again decisive: sine 10-0, triangle 8-2, glass 2-3, organ 1-2, square 2-7, reed 1-10.
- A second voice 63 % vs none 38 %; a third on the last note 3-0 in single-knob pairs (both rounds now).
- Two notes 64 % vs three 36 % (both rounds). Cues over 340 ms 18 %; 65 ms steps 67 %, 80 ms 44 %, 100 ms 42 %.
- Shape: arch (middle note above the last) 17 %, straight up and two rising notes 64 to 67 %.
- Register flipped between rounds (F4 57 % then 13 %, C4 67 % then 40 %; E♭4 90 % on n=10): left alone.
Applied: square and reed gone, the pool is sine and triangle three times each, glass and organ once. Steps 70 ms, the
four short rhythms only (no cue over four steps, 280 ms). Half the emoji get two notes. Dyads: none a quarter, a third
on the last note three eighths, a fifth there a quarter, fifths throughout an eighth. `melodySteps` swaps a middle note
above the last with it, so no tune arches. Distinct cues 899 of 1082 (test: four in five). The Cue Picks page samples
these settings as round three (steps 55, 70, 85 ms). `pnpm test` 138.

2026-09-24, "i did a few more rounds. analyse and give me an overview of all few rounds". Round three: 71 picks, 36
ties. Pooled over the three rounds, 274 picks, 132 ties, 142 decided (`scripts/cue-picks.mjs <dir>` without a round
pools them, decoding each pick with its own round's labels):
- Tone: sine 29-1, triangle 28-11, organ 8-13, glass 9-18 (0-11 in round three), square 6-14, bell 2-6, reed 4-16,
  sawtooth 1-8. Sine beat triangle 4-0 head to head in round three.
- Highest note: D5 and up 21-30, lost in every round; A4 to C5 28-21; up to G4 9-7.
- Length: 200 to 279 ms 23-13; 280 to 339 ms 26-21; under 200 ms 11-15 (2-9 in round three); 340 ms and over 18-29.
  Steps: 65 to 85 ms 6-3, 6-4, 18-13, 7-3; 100 ms 13-21; 130 ms 14-14; 55 ms 3-9.
- Rhythm: short-long 17-8, long-short-short 17-11, short-short-long 14-13, even 12-13 / 17-16, long-short 6-9,
  short-long-short 5-17.
- Notes: two 28-23 over all rounds, but three 8-4 in round three; single-knob pairs 4-4. Even.
- Second voice: yes 26-22; a third on the last note 20-13 (5-2 in single-knob pairs); the rest even.
- Shape: arch 7-12; the rest 47 to 55 %. Span: 4 to 7 semitones 53-39; 8 and over 7-16; 3 and under 7-12.
- Register: E♭4 14-5, C4 27-20, F4 18-19, D4 15-23, G4 8-15: it flipped between rounds and stays as it was.
Applied: only sine (five in eight) and triangle remain; `sound.ts` lost the PeriodicWave path. `TOP`: no note above C5
(the base stops at the third scale step, the register is drawn among those that fit). Steps 75 ms. `RHYTHMS` by note
count: two notes short-long three times in four, else even; three notes long-short-short half the time, else
short-short-long or even; short-long-short gone. Two notes for half the emoji, dyads as before. Distinct cues: 578 of
1082 (test: more than half). `pnpm test` 138. The Cue Picks page samples these settings as round four (65, 75, 90 ms).

2026-09-24, "lets do sine only and no triangles": `TIMBRES` is sine alone; the knob stays for a tone that might earn
its way back. Distinct cues fall to about 480 of 1082 (test: more than two in five).

2026-09-24, after the Cue Lab (https://claude.ai/artifact/DmwBeXhUCsostGABXeVXKa, one tune with twelve switches: mood,
envelope, slide, bend, vibrato, echo, grace note, pause, harmony, ring-out, pan, speed): "I like to add mood (both
equally likely), wobble (random value between off and slow), ring out (always short), speed (always 60ms). the rest can
stay as is."
- `MOODS`: bright (major pentatonic) or moody (`MINOR_SCALE`, minor pentatonic), a hash digit; partners and the C5 cap
  follow the mood's scale. `VIBRATOS`: four depths from none to the lab's slow wobble, a hash digit; `Cue.vibrato`
  carries it, `sound.ts` puts a 5 Hz LFO of that depth on the last note. Ring-out 0.6 of what it was. `STEP_SECONDS`
  0.06. Distinct cues back up to 759 of 1082 (test: seven in ten).
- Not checked by script: the picker's hover and focus previews, and how the cues sound on real speakers.
