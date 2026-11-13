# 80 · Flake: Firefox called the preview's site a bounce tracker during a text test

Status: open; cause not looked for
Type: flake

Seen twice on a PR's preview in Firefox, each passing on its retry, each in a test whose page does not reload before the
warning:
- 2026-10-21, run 39564621634: `text.spec.ts` "regression: a text not yet back from the Room survives a reload, shows
  once as waiting, and goes out with its id".
- 2026-11-13, the preview run of #142 at 25f334f (run 43480133149, Firefox shard 7): `text.spec.ts:244` "ADR 0009: Clear
  with "Also delete my messages from the server" takes all I wrote in the room off it, files too; friends keep theirs".
  #142 changes YouTube cards only (their card, its fullscreen button, the sender's thumbnail), nothing on this path.

```
Error: console warnings, errors or exceptions nobody expected
+   "Bob: warning: [JavaScript Warning: \"“danielmittereder.workers.dev” has been classified as a bounce tracker. If it does not receive user activation within the next 3,600 seconds it will have its state purged.\"]",
```

## What is known
Firefox's bounce tracking protection classifies a site that stores state and is left or reloaded without a user's click
(`resilience.spec.ts` expects the warning for its reload before any click, ticket 58). Bob here had no reload. Firefox
may judge the site across the whole browser, so another tab's reload in the same Firefox (Alice's, at the end of this
test) can name the site in Bob's console; the warning's timing would then be the race.

## Next
The failed try's trace: when the warning came relative to Alice's reload. If it follows another tab's reload, expect it
for every page of a test that reloads one (or turn bounce tracking protection off in the e2e Firefox profile, with a
comment why, since dave never redirects); if not, find what Firefox counted as the bounce.
