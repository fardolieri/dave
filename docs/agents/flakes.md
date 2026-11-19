# Flakes

For a test that went red and the change does not explain. `AGENTS.md` points here: read it before any re-run.

A flaky test is a bug in the app or in the test, never noise (`.scratch/p2p-friends-chat-build/issues/35-*`): find the cause,
then fix the app, fix the test, or drop the claim. A longer timeout or another retry does not count unless the cause is known.

Every failed try of every e2e and preview run goes into the flake ledger by itself (`flakes.yml`): `README.md` on the branch
`flake-ledger` counts them by test and error over 30 days, and the session briefing names the top three. Tickets are per
cause, not per sighting: a ticket lists the rows it explains in `causes.json` on that branch (a regex over test and error;
commit with `[skip ci]`), and "fixed" means its rows stop growing after the fix landed.

A flake does not hold up a PR, though: explain before landing, fix after. The preview gate goes red on a flake so that
whoever lands the PR sees it. Suspect the PR's own change first: was the same test or error seen before on commits without
it (the ledger, a flake ticket), and does the change touch the test's path or the app code its failing step runs through?
Only when the evidence clears the change, re-run the failed jobs once (`gh run rerun <id> --failed`; the gate job runs
again with them) and name the flake and the evidence in the report. That re-run is the one retry allowed without a known
cause, because the cause is still looked for after. Red again on the re-run stops the landing. Either way, add the
sighting to the ticket its ledger row links, or open one.
