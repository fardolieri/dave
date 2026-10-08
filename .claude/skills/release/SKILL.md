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
     most) and tell the owner you are waiting.
   - `failure`: do not release. Read the failing jobs, say what failed. A flake is a bug to fix, not to retry past.
3. `git log --oneline origin/prod..<sha>`: these commits go out. Note any that touch saved state (`localStorage`,
   IndexedDB) and whether they migrate.
4. `git push origin <sha>:prod`. A rejection from the ruleset means the gate is missing for that commit: go back to step 2.
   Never bypass it; if the owner wants a hotfix released without the gate, they can switch the ruleset off themselves.
5. Wait for the `deploy` run on prod and confirm it succeeded (the deployed About dialog shows the commit; `curl` the prod
   URL's HTML for the commit hash if in doubt).
6. Report: what went out (one line per commit, in plain words), the gate result, the prod deploy result, and anything
   friends will notice (changed defaults that do not reach existing browsers, a one-time reload, etc.).

The ticket convention marks shipping in the ticket's `Status:` line ("shipped <date> to prod"); update the tickets of the
released commits and commit that to master.
