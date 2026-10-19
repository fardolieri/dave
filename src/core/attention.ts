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
 * The tab's title, focused or not: the faces of everyone in the Call, you included, in the order they joined. A
 * microphone that has heard nothing for a minute puts a question in front, for a forgotten mute switch on the headset.
 */
export function titleFor(faces: readonly string[], micSilent = false): string {
  return `${micSilent ? '🔇❓ ' : ''}${APP_TITLE}${faces.length > 0 ? ` ${faces.join('')}` : ''}`;
}

/** How long the open microphone may hear nothing before the title asks whether the headset is muted. */
export const MIC_SILENCE_MS = 60_000;
/**
 * -61 dBFS, the line between a live microphone in a quiet room and a muted one, for the typical level of a minute. A
 * headset muted by its own switch need not send zeros: one of ours sent a steady hiss, typically -65.5 dBFS, against
 * -56 dBFS live in a quiet room with nobody speaking (2026-10-19, Chrome on Linux, automatic gain control on).
 */
export const MIC_LIVE_LEVEL = 10 ** (-61 / 20);
/** -34 dBFS, a voice or a knock: one such moment says the microphone is live. The muted hiss clicked to -43 dBFS at most. */
export const MIC_LOUD_LEVEL = 0.02;
/** Once silent, a second whose typical level is above the line says the microphone is back. */
export const MIC_BACK_MS = 1000;

/**
 * Watches the open microphone for a mute the app cannot see, a switch on the headset: silent once the typical level of a
 * full MIC_SILENCE_MS stays at or below MIC_LIVE_LEVEL, the median, so a click does not start the wait over. Fed the
 * microphone's level a few times a second, or null while it is closed or muted in the app, which starts the wait over,
 * as does a loud moment. `median` is the last minute's, to tell how near the line a silence was.
 */
export function createMicSilenceWatch(): (level: number | null, now: number) => { silent: boolean; median: number } {
  let readings: { at: number; level: number }[] = [];
  let since: number | null = null;
  let silent = false;
  const medianSince = (from: number) => {
    const l = readings.filter((r) => r.at >= from).map((r) => r.level).sort((a, b) => a - b);
    return l.length > 0 ? l[Math.floor(l.length / 2)]! : 0;
  };
  return (level, now) => {
    if (level === null || level > MIC_LOUD_LEVEL) {
      readings = [];
      since = level === null ? null : now;
      silent = false;
      return { silent, median: 0 };
    }
    since ??= now;
    readings.push({ at: now, level });
    while (readings[0]!.at < now - MIC_SILENCE_MS) readings.shift();
    if (silent && medianSince(now - MIC_BACK_MS) > MIC_LIVE_LEVEL) { silent = false; since = now; readings = [{ at: now, level }]; }
    else if (!silent && now - since >= MIC_SILENCE_MS && medianSince(now - MIC_SILENCE_MS) <= MIC_LIVE_LEVEL) silent = true;
    return { silent, median: medianSince(now - MIC_SILENCE_MS) };
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
