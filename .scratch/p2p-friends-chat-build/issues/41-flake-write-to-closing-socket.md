# 41 · Flake: "WebSocket is already in CLOSING or CLOSED state." after the server goes away

Status: fixed on branch fix/send-on-closed-socket (PR #42), 2026-10-11; outcome 1 of ticket 35 (the test is wrong)
Seen 2026-10-11: e2e run 38162513698 (local build, branch ci/pr-previews, a CI-only change, no app code changed), job
114538213827, Chromium: `resilience.spec.ts` "the call survives the server going away and coming back" failed on its
first try and passed on the retry. The assertion passed; the console check did not: `Alice: error: WebSocket is already
in CLOSING or CLOSED state.` That is the line Chromium logs when `send` is called on a socket that is closing or closed.

## Cause
Not the app. Every write in `client/room.ts` (`send`, the auth answer, the ping) checks first that its socket is open,
and a check and a write in one task cannot be told apart by the browser. The wire did it.

The suite's wire (`Wire` in `e2e/fixtures.ts`) is Playwright's `routeWebSocket`. The page gets a mock WebSocket, and the
real socket to the server lives in the page too, inside the mock; every frame goes page → test process → page and out
on the real socket. `Wire.cut` closed the real socket first (`server.close()`: it is CLOSING from then on) and the page's
side after (`page.close()`), each a round trip to the page. A frame Alice wrote just before or in that gap still reached
`route.onMessage` and was passed on with `server.send`, onto the closing socket: Chromium's error, in Alice's console.
Firefox writes nothing to its console for it, so only Chromium runs saw it. Which frame it was on the day is not known
(the job passed on retry and kept no trace); any late ICE candidate, mute or ping in that moment would do.

## Regression test
`resilience.spec.ts` "a frame on its way to the server as it goes away is lost with the socket, and nothing is written to
it closing": Alice's `up` tamper starts the cut the moment her text reaches the wire, then passes the text on. The real
socket is closing only until the server answers its close, which can come first on a local build: one try failed on the
first attempt and passed on the retry (run 38168912102), so the test cuts five times.
- Red, on the test alone (26c4df4): e2e run 38169376031, Chromium, failed on both attempts with the same console line;
  Firefox passed, as expected. The preview run of the same commit (38169379260, against `dave-pr-42`) failed the new test
  too, and the flaky test itself once on its first try, with the same line.
- Green with the fix (b6e9c1c): e2e run 38169890832 and the preview run 38169894475, both engines; the new test and the
  flaky one passed on their first try in both.

## Fix
The wire drops a frame on its way to a socket that is closing, as a real dropped connection loses it: each socket pair
has a `closing` flag, set as a cut begins and when either side closes, and the frame is no longer passed on once it is
set. It is still logged in `wire.log`, as the proxy saw it, like a frame a tamper drops. No app change, so the fix commit
is not a "Problem report:" and the red-green job has nothing to judge: the red receipt is the e2e run above.

## Left as it is
A close the server starts (a superseded tab, a refused join, the Room dropping a socket) leaves the same gap: the real
socket is closing before the test process hears of it, and a frame Alice writes then is passed on. The wire cannot see
that state from the test process. Not seen in any run so far; if it shows, the same line in Chromium names it. Closing
it would take an init script in the page that checks the real socket before writing.

## Comments

2026-10-11, seen alongside in the green run 38169890832, not this ticket's: Firefox, `text.spec.ts` "received history
survives a reload…" failed once and passed on the retry, Bob's reloaded chat holding "one" without "two". Probably the
gap ticket 35 accepted for the app (flake 3: the history write ends a moment after the line shows, and a reload in that
moment loses it): the test reloads as soon as "two" shows. If so, the test is wrong (outcome 1) and should wait for the
write. Not looked into further; it needs its own ticket.
