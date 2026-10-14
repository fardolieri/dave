# 52 · Flake: a call did not come back after a friend's socket dropped silently mid-offer (not looked into)

Status: open, 2026-10-14; seen once, found while working on ticket 51
Seen 2026-10-12: preview run 38308000624 of PR #48 (8eccf87, against `dave-pr-48`), Chromium shard 8, the retry of
`text.spec.ts` "regression: the chat keeps its place when the share strip comes and goes": `bob.connectedTo('Alice')`
found no badge in 20 s.

## What the wire logs show
- Both joined (Alice joinSeq 1, Bob 2). Bob offered; Alice answered, and her socket was dropped from below (ticket 51)
  with the answer in it: Bob never got it.
- Alice came back on a new socket, superseding the old one, and joined again (joinSeq 3). Bob saw presence twice, no
  `left`, and sent nothing more. At the end Bob listed no peer for Alice; Alice had hers to Bob in `have-local-offer`,
  generation 2, `stuck` 1: her watchdog's offer went up as the test ended, too late.

## Questions
Why did Bob have no peer left for Alice, and why did neither side offer again at once when Alice came back with a new
join sequence (`reconcile` in `client/call.ts`: `back` on a changed joinSeq resends an offer, but only for a peer that
still exists)? The wire's `closes` (ticket 51) will show such a drop in the next failure's artifact.
