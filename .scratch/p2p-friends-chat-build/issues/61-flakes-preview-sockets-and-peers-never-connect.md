# 61 · Flakes: against a preview, a room socket or a peer connection never comes up

Status: open
Seen 2026-10-24: the preview run of PR #92 (run 40046536450, head 345e56c, against `dave-pr-92`), three attempts. The same
suite passed against the same preview two pushes before (c23093d) and against a local build on 345e56c, in both engines;
the pushes between changed CSS and one row's markup, nothing of sockets or calls.

Attempt 1, four shards failed, all on `connected()` (`e2e/fixtures.ts`): the banner said Connecting, Reconnecting or Server
unavailable 20 s after the page opened:
- job 120729587485, Chromium: `attachment.spec.ts:460` "a pull outlives a blip of the puller's socket, and the picture
  still shows by itself".
- job 120729587557, Chromium: `resilience.spec.ts:709` "a socket gone silent without a close is given up, and the text
  written into it arrives once" (both tries); `share.spec.ts:78` passed on its retry.
- job 120729587587, Firefox: `themes.spec.ts:89` "every theme applies…" (both tries); `themes.spec.ts:175` passed on retry.
- job 120729587613, Firefox: `attachment.spec.ts:628` "waiting for a friend to come online…"; `attachment.spec.ts:546` and
  `call.spec.ts:47` passed on retry.

Attempt 2 (rerun of the failed jobs), one shard, Chromium 6: `resilience.spec.ts:709` again. Alice's wire log
(artifact 12542581888, `Alice-wire.json`) has no frame at all: two sockets, both closed by the page before they were
established ("WebSocket is closed before the connection is established"), i.e. the Worker never answered the upgrade
within the app's wait, and the app gave each up.

Attempt 3, Chromium 6: `resilience.spec.ts:709` passed; `share.spec.ts:111` "a share without sound keeps its volume
slider disabled…" failed: Bob's connection badge stayed "connecting…" for 20 s (expected direct or via relay), so the
WebRTC connection between two browsers on the same runner never came up through the preview's signaling.

## What is known
- Every failure is a connection that never came up: an upgrade not answered (ticket 48's kind), or a peer connection stuck
  connecting. No 500 on the upgrade this time (ticket 55's kind): no "Unexpected response code" line in any log.
- Each failing test passes against a local build and on other attempts; no failing step is in code this PR changed.
- Many attempts failed within the same hour, on two engines and many shards: something about the preview (its Durable
  Object, Cloudflare's edge then) rather than one test.

## Not known
- Whether the Worker or the Room got the unanswered upgrades at all: the Worker logs of `dave-pr-92` for that hour would
  tell (`upgrade failed` lines from ticket 55's diagnostic, or none).
- Why a peer connection stalls at connecting while the room's sockets are up.

## Next
Read the Worker's logs for the hour (wrangler tail cannot look back; Cloudflare's dashboard can); if the upgrades never
arrived, this is Cloudflare's, like ticket 55, and the tests' 20 s wait for a first connection is what to reconsider.

## Comments

2026-10-30, PR #114's preview at 8c1593b (run 41114344125, attempt 2, the re-run of Firefox shard 5 after ticket 72's
flake): `resilience.spec.ts:454` "an offer stuck for a friend who then reloads leaves their new connection alone (the
polite side reloads, the first to join)", Firefox, passed on its retry. A `.banner` saying Connecting, Reconnecting or
Server unavailable was still there after 20 s. PR #114 changes a file card's wording only.

## Comments

2026-11-05, preview run of PR #126 (run 42064671698, head 5a730a4), one try each, both passed on their retry:
- Firefox 5: `settings.spec.ts:216` "low bandwidth voice caps the voice…": a call badge still "connecting…". First sighting
  of that error for this test (ledger).
- Chromium 2: `attachment.spec.ts:1032` "ADR 0009: a picture … comes from the server": the test's own race (Alice left
  before the server said it kept her pieces), fixed in the test.

Suspected for the first, not shown: PR #126 gives each pair of friends a room of two, so a test opens several sockets
per browser where it opened one, and the preview's upgrade limit per IP was 120 a minute for the whole suite from one
runner. A refused upgrade (429) delays the room socket a call's signaling goes through. Raised to 600 in the same PR;
if this kind of sighting stops after, the limit was a cause here, and maybe for the sockets that never came up above.

2026-11-05, preview run of PR #126 (run 42066686999, head 5ee43a1), Chromium 5, passed on its retry:
`resilience.spec.ts:756` "a socket gone silent without a close is given up…", "Alice gives the silent socket up
herself" got `[4009, 4009]`. Not this ticket's cause: the test silenced all of Alice's sockets, her room of two with Bob
among them when it was made before the silence, and expected one close. The app was right; the test now checks the
room's socket alone (e2e wire closes carry their socket's URL). Earlier rows of this error (10-24, nightly) predate rooms
of two and stay this ticket's.
