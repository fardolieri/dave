---
name: release
description: Release master to prod in this repo — check that the master commit passed the nightly e2e gate, fast-forward prod, wait for the prod deploy, and report what went out. Use when the owner says push to prod, release, ship to prod, or similar.
---

# /release

prod only ever fast-forwards to a master commit that passed the full e2e suite against nightly. GitHub enforces this with a
ruleset on `prod` that requires the `nightly e2e passed` commit status (written by `e2e.yml` after a nightly run). This skill does
the same check first, so a refusal never comes as a surprise.

1. `git fetch origin`. The candidate is `origin/master` unless the owner names a commit; it must be a descendant of
   `origin/prod` (`git merge-base --is-ancestor origin/prod <sha>`). If it is not, stop and explain: something went to prod
   that is not on master, which must not happen.
2. Check the gate for the exact commit:
   `gh api repos/fardolieri/dave/commits/<sha>/statuses -q '[.[] | select(.context == "nightly e2e passed")][0].state'`
   - `success`: go on.
   - nothing yet: the deploy or the nightly e2e run is still going. Wait for it (one poll loop, every 60 s, about 25 min at
     most) and tell the owner you are waiting. If that nightly run ended cancelled (a re-run of an older commit took its
     place), it left no verdict: re-run it.
   - `failure`: do not release yet. Read the failing jobs (the status's `target_url` is the run) and go to step 2a.

2a. A red gate. The suite runs once against nightly and fails on any test that only passed on its retry, so a flake turns it
   red on purpose: that red is how a flake gets noticed. Release first, investigate after; but explain before you re-run.
   - Can a re-run still test this commit? A re-run tests whatever nightly serves now, writes its verdict on `<sha>`, and
     shares the nightly runs' concurrency group, so it cancels a newer one or is cancelled by it. So, **right before** any
     `gh run rerun` (not only at the start: the evidence below takes a while), `git fetch origin` and check that
     `origin/master` is still `<sha>`. If it moved, do not re-run: the newer commit's own gate decides, make it the
     candidate and go back to step 2. If the run's `run_attempt` is already above 1, it was re-run before: never again.
   - Not a test result: a shard failed before testing (the browser install, say). Say so and re-run (below).
   - A test failed, on its first try or both. **Assume the commits going out (`origin/prod..<sha>`) caused it** until the
     evidence says otherwise. Answer, with what you found:
     1. Was it seen before these commits? The same test, or the same error, in the flake ledger (`README.md` and
        `ledger.jsonl` on the branch `flake-ledger`: every failed try of every e2e and preview run, with its commit), or in
        a flake ticket (`.scratch/p2p-friends-chat-build/issues/*flake*`). A sighting on a commit that is already on prod is
        the strongest sign it is not the change.
     2. Does the change touch its path? Compare `git diff --stat origin/prod..<sha>` with the test's spec and the app code
        its failing step runs through (sockets, the call, history, …).
     3. Did it fail on the change's own runs? A `preview` run fails on a flake like nightly does (a red job); a branch's
        `e2e` run against a local build retries, so there a flake is a green job whose log says `flaky`. Read both.
   - The verdict:
     - **It looks like the change** (no sighting before, and the change touches the path, or it was flaky on the branch
       too): do not re-run and do not release. Tell the owner what is suspect; it is a bug of that change, fixed the usual
       way (regression test, then the fix).
     - **It does not**: re-run the failed jobs once, `gh run rerun <run id> --failed` (the gate job runs again with them).
       The old `failure` stays on the commit until the re-run ends: wait for the run itself to complete (one poll loop on
       the run, every 60 s, about 25 min at most), then read the status again (step 2). Green: release, and name the flake
       and your verdict in the report. Red again, on any test: stop. It is a bug, or a second flake to explain the same way
       with the owner; never a second re-run. Cancelled: if a newer master deploy took over, the newer commit becomes the
       candidate; if a shard timed out, report it, no second re-run. Before releasing on a green re-run, check once more
       that `origin/master` is still `<sha>` (else part of the re-run may have tested the newer app: take the newer commit).
   - Either way the flake is a bug to explain. The ledger records the sighting by itself; a ticket is per cause, not per
     sighting: add to the ticket its ledger row already links (`causes.json` on `flake-ledger`), or open one and link the
     row there. Say in the report which.
3. `git log --oneline origin/prod..<sha>`: these commits go out. Note any that touch saved state (`localStorage`,
   IndexedDB) and whether they migrate.
4. `git push origin <sha>:prod`. A rejection from the ruleset means the gate is missing for that commit: go back to step 2.
   Never bypass it; if the owner wants a hotfix released without the gate, they can switch the ruleset off themselves.
5. Wait for the `deploy` run on prod and confirm it succeeded (the deployed About dialog shows the commit; `curl` the prod
   URL's HTML for the commit hash if in doubt).
6. Report: what went out (one line per commit, in plain words), the gate result (on a re-run: which test was flaky, your
   verdict and its evidence, the ticket), the prod deploy result, and anything
   friends will notice (changed defaults that do not reach existing browsers, a one-time reload, etc.).

The ticket convention marks shipping in the ticket's `Status:` line ("shipped <date> to prod"); update the tickets of the
released commits and commit that to master.
