// When a socket to the Room counts as dead (quality ticket 10, ticket 54). The network can cut a socket with no close
// reaching the browser, and nothing but the browser's own TCP timeout, minutes or never, would tell. So the client pings
// every PING_INTERVAL_MS and gives the socket up when two pings in a row went unanswered: the Room answers at the edge
// (setWebSocketAutoResponse) in well under a second, and any frame from it counts as an answer. A probe (below) asks out
// of turn, when the network may have changed under the socket. Runtime-neutral.

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
  /** When the probe still unanswered went out (`probe`), or when it last had to wait (`probed`); else null. */
  probedAt: number | null;
};

export const heartbeat = (now: number): Heartbeat => ({ tickAt: now, unanswered: 0, since: null, probedAt: null });

/** A frame came in: the socket is alive. */
export function heard(h: Heartbeat): void {
  h.unanswered = 0;
  h.probedAt = null;
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

/**
 * How long a probe may go unanswered before the socket counts as dead (ticket 78). A probe is a ping sent at once, out of
 * turn, when something says the network may have changed under the socket: an ICE restart, whose offer goes out on it. A
 * router's reconnect cut the tab's sockets without a close, and the heartbeat took 60 to 90 s to tell, with the restart's
 * offer lost in the dead socket meanwhile. The Room answers in well under a second.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** A probe goes out now: whether to send it, which is not when one is already waiting for its answer. */
export function probe(h: Heartbeat, now: number): boolean {
  if (h.probedAt !== null) return false;
  h.probedAt = now;
  return true;
}

/**
 * The probe's deadline, `PROBE_TIMEOUT_MS` after it went out: answered, dead, wait, or probe again.
 * - `busy`: the socket still has something going out, or waiting for the Room's word on it (a file's pieces on a slow
 *   uplink): the ping may sit behind it, and no answer is due yet. The deadline starts again from now; the answer to
 *   what was going out counts as the probe's.
 * - A deadline met this late says the page was frozen meanwhile (a background tab), and the answer may wait behind it,
 *   as with `beat`.
 */
export function probed(h: Heartbeat, now: number, busy = false): 'alive' | 'dead' | 'wait' | 'again' {
  if (h.probedAt === null) return 'alive';
  if (busy) { h.probedAt = now; return 'wait'; }
  if (now - h.probedAt > 2 * PROBE_TIMEOUT_MS) { h.probedAt = now; return 'again'; }
  return 'dead';
}
