// Attention cues (spec §7.4): plain rules, no DOM, so they can be unit-tested.

export const APP_TITLE = 'dave';

/** Title shown while the tab is unfocused: a badge with how many people are in the Call, you included. */
export function titleFor(participantsInCall: number, unfocused: boolean): string {
  return unfocused && participantsInCall > 0 ? `(${participantsInCall} in call) ${APP_TITLE}` : APP_TITLE;
}

/**
 * Who joined and who left between two views of the Call, ignoring yourself. `stillHeld` are participants
 * whose server socket dropped but whose media is kept for the grace period (spec §8.1): a socket blip is
 * neither a leave nor, on return, a join.
 */
export function callDiff(before: Set<string>, after: Set<string>, me: string, stillHeld: Set<string> = new Set()): { joined: string[]; left: string[] } {
  const joined = [...after].filter((k) => k !== me && !before.has(k) && !stillHeld.has(k));
  const left = [...before].filter((k) => k !== me && !after.has(k) && !stillHeld.has(k));
  return { joined, left };
}


/**
 * Who started sharing between two views of the Call. Only someone already in the Call before counts: a friend coming
 * back from a server reconnect returns with their share still flagged (spec §8.1), which is no new share.
 */
export function sharesStarted(before: { present: Set<string>; sharing: Set<string> }, after: { sharing: Set<string> }): string[] {
  return [...after.sharing].filter((k) => before.present.has(k) && !before.sharing.has(k));
}
