# 64 · Flake: the nightly e2e starts while the deploy is still rolling out, and pages load a bundle that is not there

Status: open, cause seen, not fixed; seen once (two runs in the same minute)
Seen 2026-10-26: the nightly e2e run of c3934c2 (40392826988) started at 20:07:30, five seconds after its deploy
(40392676804, 20:06:28 to 20:07:25) finished. Seven shards, both engines, failed tests in their first 90 seconds (20:08:22 to
20:09:39) and all of them passed on the retry, so the gate went red. The tests had nothing in common (privacy, private,
adversary, themes, share); the errors did: Chromium's `Failed to load resource: the server responded with a status of 404 ()`
and Firefox's `Loading failed for the module with source "…/assets/index-*.js"`. A soak run against nightly
(40392832444) failed the same way at 20:08:18 and passed on the same seed eight minutes later.

Not the commit: c3934c2 changes one ticket file. The next master commit, e14d59b, passed the gate, though its run also
started three seconds after its deploy (20:32:46, 20:32:49): the window is not hit every time.

## Cause
For about a minute after `wrangler deploy` returns, nightly's HTML and its `/assets/` disagree: a page names an
`index-*.js` that its edge answers with 404, one build ahead of or behind it. `e2e.yml` starts the shards as soon as the deploy
run completes and does not check that nightly serves the deployed commit.

## Questions
Which way round is it, new HTML with old assets or the reverse? Is it Workers static assets propagating, or the service
worker's cache? A friend who opens the app in that minute would get the same broken page: does the app recover on its own
(the update banner, a reload), or does it stay blank? That decides whether the fix is only the test's (wait until nightly's
HTML shows the commit and its bundle loads, as `/release` step 5 checks on prod) or also the app's.

Not linked in `causes.json`: its rows carry the tests' generic errors ("console warnings, errors or exceptions nobody
expected", `toEqual`), and a pattern over those would claim unrelated sightings.
