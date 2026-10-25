/**
 * A room the app let in again after lost sockets (its `[recovered]` line, which has the start of the room id only), and how
 * many problems were logged before it.
 */
export type Recovery = { room: string; after: number };

/** Chromium's own line for a room socket it could not open: an upgrade reset, refused or answered 500 (tickets 55, 60). */
const SOCKET_FAILED = /^error: WebSocket connection to '[^']*\/ws\/([^'/?#]+)[^']*' failed/;

/**
 * The console problems that fail a test: those no pattern expects, less the browser's errors for a room socket it could not
 * open when the app logged that room's recovery after them. The app tries a socket again on its own, so such an error with
 * the room let in after it is a fault the app got over; one with no recovery after it is still a failure.
 */
export function unexplained(problems: readonly string[], expected: readonly RegExp[], recoveries: readonly Recovery[]): string[] {
  return problems.filter((p, i) => {
    if (expected.some((re) => re.test(p))) return false;
    const room = SOCKET_FAILED.exec(p)?.[1];
    return !(room && recoveries.some((r) => room.startsWith(r.room) && r.after > i));
  });
}
