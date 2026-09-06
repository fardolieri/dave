// Attention cues (spec §7.4): plain rules, no DOM, so they can be unit-tested.

export const APP_TITLE = 'dave';

/** Title shown while the tab is unfocused: a badge with how many friends are in the Call. */
export function titleFor(participantsInCall: number, hidden: boolean): string {
  return hidden && participantsInCall > 0 ? `(${participantsInCall} in call) ${APP_TITLE}` : APP_TITLE;
}

/** Which keys joined and which left between two presence snapshots of participants, ignoring yourself. */
export function callDiff(before: Set<string>, after: Set<string>, me: string): { joined: string[]; left: string[] } {
  const joined = [...after].filter((k) => k !== me && !before.has(k));
  const left = [...before].filter((k) => k !== me && !after.has(k));
  return { joined, left };
}

/** Two short notes: rising for a join, falling for a leave. Frequencies in Hz, duration per note in seconds. */
export const CHIME = { join: [523.25, 659.25], leave: [659.25, 523.25], noteSeconds: 0.09, gain: 0.08 } as const;
