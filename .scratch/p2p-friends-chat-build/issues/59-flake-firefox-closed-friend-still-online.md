# 59 · Flake: a friend whose browser closed in Firefox stays online for the others past 20 s

Status: needs-triage
Seen 2026-10-18: the preview run of PR #75 (39087065000, head eb353ce, against `dave-pr-75`), Firefox, shard 2, passed on
the retry: `attachment.spec.ts:452` "a file sent again by a second friend comes from her while the first is away". After
`alice.close()`, `bob.online()` still listed Alice 20 s later (`["Carol", "Alice", "Bob"]`). The retry saw her go within
6.5 s. The branch changed only theme CSS and the theme test; nothing on the socket or presence path.

Seen again 2026-10-18: the nightly e2e of ff55f56 (run 39171574137, job 117805554468, against `dave-nightly`), Firefox,
shard 2, the same test (now `attachment.spec.ts:518`), the same `["Carol", "Alice", "Bob"]` after 20 s, passed on the
retry in 6.6 s. It failed the release gate of that commit; a rerun of the failed jobs passed clean. Again a change of
theme CSS only (Kino's glows): the flake is reachable against real Cloudflare on nightly too, not only on a preview.

## What the trace shows
Every page's socket goes through the fixture's `routeWebSocket` (`e2e/fixtures.ts`, `Wire.attach`): the connection to
the server is opened by Playwright for the page, and `route.onClose` forwards a close to it. `alice.close()` closes her
browser context and nothing else. No presence frame without Alice reached Bob in the 20 s.

## Likely cause (not proven)
The close of Alice's server-side socket did not reach the Room. The Room then keeps her until its sweep: no ping for
`SILENT_TIMEOUT_MS` (90 s), checked every `SWEEP_INTERVAL_MS` (60 s), so 90 to 150 s. Whether Firefox (Juggler) leaves a
routed socket open for a while when its context closes, or the close is lost between the runner and Cloudflare, the
trace cannot tell: it has no frames after the context closed.

## To find out
- Log the Wire's `closes` for the closing friend in the test (did `route.onClose` fire, with which code, and did
  `server.close` go out?).
- If the fixture's close is the gap: `Friend.close()` could close its open server sockets with 1001 (going away), as a
  real tab does, before closing the context. Check first that no test relies on a closed friend's socket lingering (the
  "puller's tab died mid-pull" regression wants old links left open; that is the peer links, not the server socket).
- If Cloudflare loses the close: the app is fine and the test's claim needs the sweep's time, or the claim goes.
</content>
</invoke>
