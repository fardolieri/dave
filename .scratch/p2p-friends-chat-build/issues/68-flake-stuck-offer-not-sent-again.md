# 68 · Flake: after a friend reloads, the offer stuck for them is not sent again

Status: open, cause suspected, not proven
Type: flake

Seen, "… sends the stuck offer again" (`resilience.spec.ts`, "an offer stuck for a friend who then reloads leaves their
new connection alone", one of its four variants each time), passing on the retry:
- 2026-10-09: branch flake/low-bandwidth-voice (89b9907, 91f564b), both engines, Alice's and Bob's variants.
- 2026-10-28: the preview of PR #102 (e54675d, run 40762088318), Chromium, "the impolite side reloads, the first to
  join". Not the change of that PR: it touches row O4 for a connection that had connected and whose ICE failed, and
  the step that failed is the offer sent again on the friend's return (R14); the same error was seen before tickets 63,
  66 and 67.

## Suspected cause
A race between two ways the offerer learns of the reload. R14 sends the stuck offer again when presence shows the
friend back (a new join sequence). But the reloaded page, holding the newest join sequence when it was the first to
join, offers itself from a new connection; if that fresh offer reaches the offerer before the presence update, O4 closes
the offerer's connection, stuck offer and all, and answers the new one. The call is fine, the test's expectation is
not met. If so, the test is wrong for that ordering, not the app: the claim to keep is that the reloader's new
connection is left alone and the call comes back.

## To do
Read the failing try's wire log (the `e2e-flaky-chromium-*-40762088318-1` artifact, 14 days): which came first at the
offerer, the presence or the fresh offer. Then fix the test or the app accordingly.
