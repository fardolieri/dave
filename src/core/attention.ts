// Attention cues (spec §7.4): plain rules, no DOM, so they can be unit-tested.

export const APP_TITLE = 'dave';

/**
 * How a person shows in the tab's title: the profile picture, else the initial of the name the avatar shows, in a bold
 * letter so it reads as a face and not as part of a word.
 */
export function titleFace(person: { name: string; picture?: string | null }): string {
  if (person.picture) return person.picture;
  const initial = [...person.name][0]?.toUpperCase() ?? '?';
  return /^[A-Z]$/.test(initial) ? String.fromCodePoint(0x1d5d4 + initial.charCodeAt(0) - 65) : initial;
}

/**
 * The tab's title, focused or not: the faces of everyone in the Call, you included, in the call list's order. A
 * microphone that has heard nothing for a minute puts a question in front, for a forgotten mute switch on the headset.
 */
export function titleFor(faces: readonly string[], micSilent = false): string {
  return `${micSilent ? '🔇❓ ' : ''}${APP_TITLE}${faces.length > 0 ? ` ${faces.join('')}` : ''}`;
}

/** How long the open microphone may hear nothing before the title asks whether the headset is muted. */
export const MIC_SILENCE_MS = 60_000;
/**
 * -40 dBFS, a sound clearly heard: a cough, a word, a knock. Loudness alone cannot tell a headset muted by its own switch
 * from a live one in a quiet room: one of ours hissed at -76 dBFS muted and -74.5 live, -58 and -56 with automatic gain
 * control (2026-10-19). So someone who was merely quiet for a minute is asked too, and a cough answers. The switch's
 * click reached -43 dBFS, under the line, so muting does not start the minute over.
 */
export const MIC_SOUND_LEVEL = 0.01;

/**
 * Watches the open microphone for a mute the app cannot see, a switch on the headset: silent once nothing above
 * MIC_SOUND_LEVEL came in for MIC_SILENCE_MS, until the next such sound. Fed the microphone's level a few times a second,
 * or null while it is closed or muted in the app, which ends a silence and starts the wait over.
 */
export function createMicSilenceWatch(): (level: number | null, now: number) => boolean {
  let since: number | null = null;
  return (level, now) => {
    if (level === null) since = null;
    else if (since === null || level > MIC_SOUND_LEVEL) since = now;
    return since !== null && now - since >= MIC_SILENCE_MS;
  };
}

/** One view of the Call for cues: who presence lists as a participant, and whom I still hold a peer connection to. */
export type CallView = { present: Set<string>; kept: Set<string> };

/**
 * Who joined and who left between two views of the Call, ignoring yourself. A friend counts as in the Call while presence
 * lists them or while I still hold a connection to them: a server socket that drops while the voice stays up (spec §8.1,
 * ticket 31) is neither a leave nor, on return, a join. They leave once both are gone, whichever goes last. The connection
 * is read in the same pass as presence on purpose: a flag that the call sets in reaction to that presence comes too late.
 */
export function callDiff(before: CallView, after: CallView, me: string): { joined: string[]; left: string[] } {
  const was = new Set([...before.present, ...before.kept]);
  const is = new Set([...after.present, ...after.kept]);
  const joined = [...is].filter((k) => k !== me && !was.has(k));
  const left = [...was].filter((k) => k !== me && !is.has(k));
  return { joined, left };
}


/**
 * Who started sharing between two views of the Call. Only someone already in the Call before counts: a friend coming
 * back from a server reconnect returns with their share still flagged (spec §8.1), which is no new share.
 */
export function sharesStarted(before: { present: Set<string>; sharing: Set<string> }, after: { sharing: Set<string> }): string[] {
  return [...after.sharing].filter((k) => before.present.has(k) && !before.sharing.has(k));
}
