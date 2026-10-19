// Attention cues (spec §7.4): plain rules, no DOM, so they can be unit-tested.

export const APP_TITLE = 'dave';

/**
 * How a person shows in the tab's title: the profile picture, else the initial as the avatar shows it, in a bold
 * letter so it reads as a face and not as part of a word.
 */
export function titleFace(person: { name: string; picture?: string | null }): string {
  if (person.picture) return person.picture;
  const initial = [...person.name][0]?.toUpperCase() ?? '?';
  return /^[A-Z]$/.test(initial) ? String.fromCodePoint(0x1d5d4 + initial.charCodeAt(0) - 65) : initial;
}

/**
 * The tab's title, focused or not: the faces of everyone in the Call, you included, in the order they joined. A
 * microphone that has heard nothing for a minute puts a question in front, for a forgotten mute switch on the headset.
 */
export function titleFor(faces: readonly string[], micSilent = false): string {
  return `${micSilent ? '🔇❓ ' : ''}${APP_TITLE}${faces.length > 0 ? ` ${faces.join('')}` : ''}`;
}

/** How long the open microphone may hear nothing at all before the title asks whether the headset is muted. */
export const MIC_SILENCE_MS = 60_000;
/**
 * Any sound at all, -80 dBFS: room noise that the voice gate keeps back counts. A headset muted by its own switch sends
 * zeros, or the converter's hiss far below this.
 */
export const MIC_ACTIVITY_LEVEL = 1e-4;

/**
 * Watches the open microphone for a mute the app cannot see, a switch on the headset: silent once it has heard nothing
 * for MIC_SILENCE_MS. Fed the microphone's level a few times a second, or null while it is closed or muted in the app,
 * which starts the wait over. `peak` is the loudest level since the last sound, to tell how near the line a silence was.
 */
export function createMicSilenceWatch(): (level: number | null, now: number) => { silent: boolean; peak: number } {
  let since: number | null = null;
  let peak = 0;
  return (level, now) => {
    if (level === null || level > MIC_ACTIVITY_LEVEL || since === null) { since = level === null ? null : now; peak = 0; }
    else peak = Math.max(peak, level);
    return { silent: since !== null && now - since >= MIC_SILENCE_MS, peak };
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
