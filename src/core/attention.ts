// Attention cues (spec §7.4): plain rules, no DOM, so they can be unit-tested.

export const APP_TITLE = 'dave';

/** Title shown while the tab is unfocused: a badge with how many people are in the Call, you included. */
export function titleFor(participantsInCall: number, unfocused: boolean): string {
  return unfocused && participantsInCall > 0 ? `(${participantsInCall} in call) ${APP_TITLE}` : APP_TITLE;
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
