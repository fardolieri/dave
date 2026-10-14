// When a socket to the Room counts as dead (quality ticket 10, ticket 54). The network can cut a socket with no close
// reaching the browser, and nothing but the browser's own TCP timeout, minutes or never, would tell. So the client pings
// every PING_INTERVAL_MS and gives the socket up when two pings in a row went unanswered: the Room answers at the edge
// (setWebSocketAutoResponse) in well under a second, and any frame from it counts as an answer. Runtime-neutral.

/** Pings in a row with no frame from the Room after them, before the socket counts as dead. */
export const PINGS_UNANSWERED = 2;

/**
 * A tick this much later than the one before says the page was frozen or suspended (a phone's background tab, a laptop
 * asleep), not that the socket is silent: an answer may be waiting in the queue behind the tick. Chrome's intensive
 * throttling of hidden tabs runs a 30 s timer once a minute, which is not late by this measure.
 */
export const LATE_TICK_MS = 75_000;

export type Heartbeat = {
  /** When the last tick ran. */
  tickAt: number;
  /** Pings that went out since the last frame came in. */
  unanswered: number;
  /** When the first of them went out. */
  since: number | null;
};

export const heartbeat = (now: number): Heartbeat => ({ tickAt: now, unanswered: 0, since: null });

/** A frame came in: the socket is alive. */
export function heard(h: Heartbeat): void {
  h.unanswered = 0;
  h.since = null;
}

/**
 * The timer's tick: send a ping, or give the socket up. Only a tick on time gives it up, so the pings it counts were
 * answered or not in real time: after a freeze, the next tick pings once more and the one after that decides.
 */
export function beat(h: Heartbeat, now: number): 'ping' | 'dead' {
  const late = now - h.tickAt > LATE_TICK_MS;
  h.tickAt = now;
  if (!late && h.unanswered >= PINGS_UNANSWERED) return 'dead';
  h.unanswered++;
  h.since ??= now;
  return 'ping';
}
