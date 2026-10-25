# Flake ledger

Every e2e try that failed in the last 30 days, by test and error, newest data 2026-10-25T22:57 UTC.
Written by `flakes.yml` after each e2e and preview run (`scripts/flakes/ledger.mjs` on master). A flaky try failed and
passed on its retry; against nightly a test that failed both tries counts too, on branches and previews only flaky
ones do (failing twice there is mostly the branch's own bug). Runs hunting a flake (-g, --repeat-each) are kept but not counted. The ticket
column comes from `causes.json` here: one ticket per cause, its rows matched by a regex over "file › test | error".

Runs recorded: nightly 1.

| Seen | Flaky | Where | Test | Error | First | Last | Ticket |
|---:|---:|---|---|---|---|---|---|
