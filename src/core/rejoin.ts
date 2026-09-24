/**
 * Rejoin (ticket 24): a reloaded page re-enters the Call without a click when this browser was in it moments ago.
 * While in the Call the page keeps a marker fresh in localStorage (a heartbeat, because Android kills a background
 * app without any page event, and never sessionStorage, which Chrome for Android does not restore after a kill).
 * A deliberate Leave removes it.
 */
export type RejoinMarker = {
  /** The room id whose Call this browser was in. */
  room: string;
  /** When the marker was last written, ms since epoch. */
  at: number;
  /** Sharers whose share I was watching, so the pictures come back too. */
  watching: string[];
};

export const REJOIN_HEARTBEAT_MS = 10_000;
/** A marker older than this is from a call left long ago (a closed tab reopened, a browser restart): no Rejoin. */
export const REJOIN_WINDOW_MS = 30_000;

export function parseRejoinMarker(raw: string | null): RejoinMarker | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<RejoinMarker>;
    if (typeof m.room !== 'string' || typeof m.at !== 'number') return null;
    const watching = Array.isArray(m.watching) ? m.watching.filter((k): k is string => typeof k === 'string') : [];
    return { room: m.room, at: m.at, watching };
  } catch { return null; }
}

/** The marker if it names this room and is recent enough to rejoin, else null. */
export function rejoinFor(marker: RejoinMarker | null, room: string, now: number): RejoinMarker | null {
  if (!marker || marker.room !== room) return null;
  const age = now - marker.at;
  return age >= 0 && age < REJOIN_WINDOW_MS ? marker : null;
}
