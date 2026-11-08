# 74 · Flake: About's Close moved under the click as the server's history figures came in

Status: fixed in #126 (the fold, 62d5268 there); fixed means its ledger row stops growing
Type: flake

Seen 2026-11-05: the preview run of #126 at 807c058 (run 42079021936), Firefox, shard 6, passed on its retry.
`settings.spec.ts:370` "About shows the relay this month and the free plan today…": the About button's click timed out
behind `<dialog open class="about">`, which "intercepts pointer events". The dialog was still open from the step before.

## Cause
In the trace, the click on Close aimed at y=498 (its box then 479–517). The screenshot at the failure has Close near
y=574: the section "Kept on the server" (ADR 0009, new in #126) arrived from `/history-usage` between Playwright's aim
and its click, grew the dialog by some 76 px, and the click landed on the meter's note instead. Nothing closed it. The
test did not wait for that section before closing.

## Fix
Since the fold (#126, "About folds its usage figures away"), every figure is inside `details.usage-all`, folded until
asked for. The fold appears with the first answer, and the tests wait for it (and for its summary) before Close. Later
answers fill a closed fold or replace figures already shown, so Close no longer moves. Not yet: a person who taps Close
within the first moment, before the fold appears, can still miss it.
