# 35 · The flaky browser tests: find each cause, make the test or the app robust

Status: open 2026-09-29
Asked for 2026-09-29: "Create a ticket that should investigate the flaky tests and make them more robust." Prompted by
the nightly run after ticket 34 (2026-09-28 21:46 UTC, run 36488333876), where one Chromium test failed twice and then
passed on a rerun of the job, delaying the release. Every test below passed locally in both engines the same day, so
these are timing, network or ordering flakes, not steady failures. Three from green master, in the last two days, and a fourth from the first sharded run:

## The flakes seen (GitHub Actions, workflow e2e, against nightly unless said)
1. `resilience.spec.ts` "a stalled connection is rebuilt and comes up again" (ticket 22): Chromium, 2026-09-28 21:46,
   twice (retry included), the badge stayed at "connecting…" for the full expect timeout after `__dave.rebuild`; the
   Firefox job of the same run passed; the rerun passed. The rebuild is relay-only (`iceTransportPolicy: 'relay'`),
   so on nightly it depends on Cloudflare TURN credentials and the relay path, which no local run exercises (the
   local build has STUN only, see memory of 2026-09-23). Questions: did the relay candidates gather at all (the
   `relay_candidate_gathered` event, `peer_connecting_slow` with its counts)? Does the stuck-connecting watchdog fire
   inside the test's timeout, and does the test wait for its second attempt? Is 20 s enough for an ICE restart over
   TURN, or should the test's expect for a relay-only rebuild be longer, or read the hook instead of the badge?
2. `settings.spec.ts` "a friend's volume and the master volume multiply, and survive a reload": Firefox, 2026-09-27
   02:32 (run 36288825461) and 2026-09-28 18:55 (run 36468561834, twice): the assertion itself passed and the test
   failed on an unexpected console line, `Alice: warning: signal handling failed JSHandle@object`. That is a late
   candidate or description from the connection torn down by Alice's reload reaching the new one (the same race
   ticket 22's test expects with `expectWarning(/signal handling failed/)`, and f05a9c5 dropped candidates before any
   description for). Either the app should not log it as a warning when it is expected (a candidate for a connection
   that no longer exists is not a problem), or the fixture should count it as environment noise after a reload.
3. `update.spec.ts` "ticket 33: with the server gone the app still opens, from the service worker": Firefox,
   2026-09-28 18:55, twice: the text "before the outage" never showed after the offline reload (`element(s) not
   found`). Ticket 33's own notes say the offline test "waits for the echo" (1c187c3); on nightly the echo may not
   be the last thing before the outage, or Firefox's service worker may not have taken control before the reload.
   Questions: was the worker controlling the page (`navigator.serviceWorker.controller`) when the socket was cut? Is
   the history written before the reload? Does the test need to wait for `controllerchange` explicitly on Firefox?

4. `text.spec.ts` "texts in a row from one writer go under one name": Firefox, 2026-09-29 18:40 (run 36613285178,
   the sharded suite against nightly, shard 4, one worker), once; the retry passed. Bob sent "three", then Alice sent
   "four", and Bob's chat held one, two, four, three for the whole 20 s poll: a lasting order, not a slow one. `say`
   (fixtures.ts) only waits for the composer to empty, not for the server to take the text, so Alice's "four" can
   reach the Room first when Bob's socket is slower; on nightly, over the real network, that is milliseconds apart.
   Questions: is the order Bob shows the Room's order (then the test races, and should wait for Bob's own "three"
   to come back before Alice writes), or does Bob place his own text where he sent it and the others where they
   arrived (then the order differs between friends, which "everyone sees the same order" is meant to rule out)?

## Findings
- Flake 4, outcome 1 (the test): every chat line, your own too, is shown when the Room's broadcast comes back
  (`client/room.ts`, no optimistic line), so every friend shows the Room's order. Bob's "three" after Alice's "four"
  means the Room took them that way: `say` returned on an empty composer, before Bob's text had reached it. `say` now
  waits for its own text to come back (fixtures.ts), which is what every test using it assumed. Done: 20 of 20 against
  nightly in Chromium and in Firefox, first try (run 36619412001, 2026-09-29).
- Flake 2, probably fixed by f05a9c5 already (outcome 4, the app): both runs that saw it (36288825461, 36468561834)
  predate that commit, which drops candidates that arrive without a description. In the 10 e2e runs since, 16 runs of
  the test in both engines, it did not come back; before, 2 in 16 in Firefox. Done: 20 of 20 against nightly in
  Chromium and in Firefox, first try (run 36619412001, 2026-09-29); at the old rate 0 in 20 would be a 7 % chance.
  Its traces only said `JSHandle@object`: the fixture now reads out an error object Firefox logs that way, so a next
  report names the error.
- Flake 1, outcome 2 (the app): a signal from one friend could hold every later signal from them for good. Signals
  are applied one at a time on a chain keyed by identity, which outlives the connection on purpose (ticket 22). A
  setRemoteDescription or addIceCandidate still running when its connection is closed never settles: per the WebRTC
  spec, and Chromium does exactly that (probed 2026-09-29: both still pending 3 s after close; Firefox settles them).
  On nightly, Bob's relay candidates trickle in late, right when the test calls `rebuild`; the close stalled the chain,
  the new connection's answer never got applied (Alice's ICE stayed "new", nothing logged), the watchdog's relay-only
  retry hung behind it too. Friends met the same: the watchdog, an ICE failure or a lost server close a connection
  outside the chain, and that friend could not connect again until a reload. Each step on a connection now ends when
  closePeer closes it (`unlessClosed`, client/call.ts). Before: 5 of 20 failed in Chromium against nightly, 2 of them
  on the retry too, all with Alice at ICE "new", relay-only, third connection; Firefox 20 of 20 (run 36622849661).

Not flakes but worth knowing: `privacy.spec.ts` "a yes starts PostHog and tells the server" failed on every push of
2026-09-27 03:36 to 04:59; those were ticket 32's own iterations, green since 05:05. On the same pushes
`resilience.spec.ts` "the call survives the server going away" and "a friend cut off from the server stays in the
call" (ticket 31) failed once each in Chromium; keep an eye on them, they share the server-outage machinery with
flake 3.

## The rule (decided with Daniel, 2026-09-29)
A flaky test is a question, and a retry that turns it green hides the answer. Each flake ends with its cause found and
one of four outcomes, written under the test:
1. The test is wrong, the feature is fine: fix the test.
2. The feature is wrong: fix the app. If the promise is not worth keeping, drop the feature claim and its test together,
   decided with Daniel; never the test alone.
3. The environment is wrong (nightly's TURN relay, a slow runner): the test stops depending on it, by waiting on the
   state the app reports, or by running only where the environment is ours.
4. The test is stricter than the feature: a console line the app should not print. Quiet the app, not the test.
Never a longer timeout or another retry without the cause.

## Approach
- Check a fix against nightly with the e2e workflow by hand: target `nightly`, `grep` the title, `repeat` 20. The
  repeats spread over the 8 shards, so 20 take about as long as a normal run. This VM runs no Firefox.
- For each: pull the run's trace (`gh run download <id>`, the `e2e-results` artifact, `playwright show-trace`) and
  read the console and network of the failing attempt before changing anything.
- Make the app quieter where the noise is expected (flake 2) rather than widening the fixture's allowlist, unless
  the line really is environment noise (`environmentNoise` in `e2e/browsers.ts`).
- Where the test waits on a UI badge for a network process (flake 1), wait on the state the app itself reports
  (`__dave.peers()`, the connection state) with a timeout that fits a relay rebuild, and record in the test why.
- Run each fixed test 10 times against nightly (`E2E_URL=nightly pnpm exec playwright test -g "<title>" --repeat-each 10`)
  in both engines before calling it robust; note the pass counts here.
- If a cause turns out to be the nightly environment (TURN quota, a cold Durable Object), say so here and decide
  with Daniel whether the suite should retry that test, skip it on nightly, or the app should cope.

## Done when
- The four tests above pass 10 of 10 repeats against nightly in Chromium and Firefox, with the cause of each flake
  written under the test in the spec file.
- A nightly run after a master push has been green without a rerun three times in a row.
