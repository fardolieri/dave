// How signals from one friend are applied (client/call.ts): one at a time, in arrival order, each step on a connection
// ending when that connection is closed. Pure promises, no imports.

/**
 * Steps queued under one key run one at a time, in the order they were queued; keys run independently. A step that
 * throws is handed to `onError` and the next one runs. Signals are keyed by identity rather than by connection object:
 * the very first offer creates the connection while awaiting setRemoteDescription, and the candidates behind it must
 * wait for that, not race past it. The chain outlives any one connection on purpose (ticket 22).
 */
export function keyedChain(onError: (e: unknown) => void): (key: string, step: () => Promise<void>) => Promise<void> {
  const chains = new Map<string, Promise<void>>();
  return (key, step) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(step).catch(onError);
    chains.set(key, next);
    return next;
  };
}

/** What a step raced against a closed connection rejects with; not an error, the step belongs to a connection that is gone. */
export const CLOSED = Symbol('connection closed');

/** Settles once, when `close` is called: one per connection. */
export function closeLatch(): { closed: Promise<void>; close: () => void } {
  let close!: () => void;
  const closed = new Promise<void>((r) => { close = r; });
  return { closed, close };
}

/**
 * `step`, or a rejection with CLOSED as soon as `closed` settles. A setRemoteDescription or addIceCandidate still
 * running when its connection is closed never settles (WebRTC spec; Chromium, 2026-09-29), and the chain above outlives
 * the connection: one close at the wrong moment (the watchdog, a rebuild, an ICE failure) would hold every later signal
 * from that friend, the new connection's answer too, for good. Ticket 35, flake 1.
 */
export const unlessClosed = <T>(closed: Promise<void>, step: Promise<T>): Promise<T> =>
  Promise.race([step, closed.then((): never => { throw CLOSED; })]);
