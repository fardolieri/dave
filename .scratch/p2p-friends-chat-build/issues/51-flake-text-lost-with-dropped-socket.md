# 51 · Flake: a text written into a socket the network dropped was gone for everyone

Status: shipped 2026-10-14 to nightly and prod (prod 41657fb, nightly e2e green first); fixed on branch fix/followups (PR #48), 2026-10-14; outcome 2 of ticket 35 (the app is wrong), with a limit left
Seen 2026-10-12 on the preview of PR #48 (`dave-pr-48`), three runs, each passing or failing on a text that never came:
- 38294593052 (44895d3): Chromium `text.spec.ts` "text is plain…" and Firefox `settings.spec.ts` "phone width…", Alice's
  own text never came back from the server; both passed on the retry.
- 38308000624 (8eccf87): `text.spec.ts:178` "the chat keeps its place…", Alice's "filler line 14" never came back; the
  retry failed too, Bob's call to Alice never connecting after the same drop.
- 38314922272 (ac79f81): `text.spec.ts:30` "everyone sees the same order…", Alice got 6 of 10 texts; passed on the retry.

## What the artifacts show
The wire logs of every failed try tell the same story: a friend's socket, let in and working, ends with no frame from the
Room, and the friend comes back on a new socket a second later. The Room never noticed the first one go: the other friend
got no presence without her, only the one of her new socket superseding the old (`supersede`). Mostly it happened within
a second or two of another socket of the room connecting. Whatever was in flight was lost:
- her own text written into the dead socket (three of the four), which no one ever saw and nothing said was not sent;
- texts the others sent while the Room still took the dead socket for hers (the 6 of 10).

## Not this branch
Diagnostic branch diag/text-drops-48 (deleted): the wire recorded how each socket ended, retries off, `text.spec.ts`
repeated against both the PR #48 preview and nightly (master's c0b02d2). A socket let in and closed from below with 1006:
- e2e runs 38562119799 and 38562942049 against `dave-pr-48`: once in 400 tests (Alice, 1.6 s after she was let in, just
  as Bob came in);
- e2e runs 38562076960 and 38562944510 against nightly: once in 400 tests (Alice, as Bob's reload reconnected).
The same drop at the same rate with master's code, so the branch does not cause it. Where it happens (the edge, the
runner's network, Playwright's socket proxy) is not known from here; the Room sees nothing of it. It never failed a
nightly run: a test fails only when the drop falls on a text in flight.

## Regression tests
`text.spec.ts` "a text lost with its socket is sent again on the next one" (the wire drops Alice's text on the way up,
then cuts the socket) and "a text that reached the Room before its socket was lost shows once, for the others too" (the
wire drops its way back down to Alice).
- Red, on the tests alone (765bee0): e2e run 38564659449 and preview run 38564665140 (against `dave-pr-48`), Chromium
  and Firefox, both tries, at Bob's chat and at Alice's; the only failing tests.

## Fix
Each text carries an id its writer picks at random, which the Room passes on. The writer keeps her texts until they come
back; a text the last socket took and never brought back is sent again on the next socket, in order. A receiver shows a
writer's text of an id it has shown already only once, so a text that had reached the Room the first time does not show
twice. A text the Room refused ("Not sent") is not sent again, nor one still out when another tab takes the room (it
would come out of context when this tab takes it back). Old clients send no id and are relayed as before.
- Green with the fix (1b828cb): e2e run 38565613718 and preview run 38565621802, both engines, no test retried; the
  red-green run 38565613602 ran the new tests against the app from before the branch and saw them fail there. The final
  head (41657fb): e2e run 38566438023, preview run 38566442310, no test retried; nightly e2e run 38567366899 passed.
- Review (independent subagent): nothing serious. Fixed: the tab taken over (above). Left: while old and new builds
  overlap after a deploy, a text sent again to a Room from before ids can show twice for the others, and an own text
  without an id from an old tab of the same identity clears the oldest one still out; both end with the deploy. A text
  sent again after its echo was lost can be refused by the rate limit (40 at once) and say "Not sent" though the others
  have it.

## Left as it is
Texts others send while a friend's socket is down still miss her: the Room keeps none (spec §4), and here it did not even
know her socket was gone. The "everyone sees the same order" test fails when a drop falls on its burst, about one run of
it in several hundred; the wire log of a failed test now has its `closes`, so such a failure tells itself apart.
The 8eccf87 retry also showed Bob's call to Alice not coming back after her socket was superseded: ticket 52, open.
