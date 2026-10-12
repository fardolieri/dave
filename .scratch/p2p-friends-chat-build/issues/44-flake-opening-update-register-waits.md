# 44 · Flake: the opening update showed no line in Firefox when the browser found the new version first

Status: shipped 2026-10-12 to nightly and prod (prod 961c90a, nightly e2e green first); fixed on branch flake/update-134 (PR #44), 2026-10-11; outcome 2 of ticket 35 (the app)
Seen 2026-10-11: e2e run 38170369815 (local build, branch fix/send-on-closed-socket, PR #42, no update code changed),
job 114561541355, Firefox: `update.spec.ts` "ticket 36: a new version found as the app opens downloads behind a line…"
failed on its first try and passed on the retry. `.update-line` never showed in 20 s after Alice's reload. The job
passed, so it kept no trace.

## Cause
The app, in both engines; the race is Firefox's. `watchForUpdates` (`client/update.ts`) learned of its registration only
from `register()`. A register job waits in the browser's job queue behind any install under way, until that install
ends. Firefox runs its own update check as a navigation starts. When that check comes first, the new version installs
(RNNoise, 6 MB at the test's 1.5 MB/s, about 4 s), and `register()` in the page loaded meanwhile resolves only after.
By then the opening check's 1.5 s had ended the opening: the app unfroze and connected, the download's progress was
ignored (no worker followed yet), no line showed, and once installed the bar asked, as for a version found later. The
promise of ticket 36 (a version found as the app opens downloads behind the line and is taken) did not hold.

Found with a diagnostic run (branch diag/update-134, not merged: no retries, an init script logging the service worker's
timeline to the console): e2e run 38176885853, the test 80 times per engine, 1 failure in Firefox, none in Chromium.
Its trace, in ms from the reload's page load: `register` called at 148; the install's first progress report at 242
(the browser's own check, the page had not asked yet); Join enabled at 1547 (the opening over); `register` resolved at
4070 with the new version already `waiting`; the bar at 4088. `getRegistration()` resolved at 92, at once.

## Regression test
`update.spec.ts` "a new version the browser is still downloading as the page loads is taken the same way, though
registering waits for that download": the check starts in the page before (the line shows there), and Alice reloads
while the download, about 6 s at 1 MB/s, goes on. That puts an install ahead of the new page's `register()` every time.
- Red, on the test alone (f20e7f0): e2e run 38177967554, Chromium and Firefox, both attempts, at "the download shows
  after the reload too". So Chromium has the same gap; only its own check comes later than Firefox's, after the page
  registered. The red-green job of the fix (run 38178621217) found it red on the app before the branch too.
- Green with the fix (d770a63, and d10dd4a, where the new test polls for the socket count as the first one does,
  from review): e2e run 38179193250 and the preview run 38179196423, both engines, every test on its first try. Both
  tests 40 times in each engine (run 38179875691): 160 of 160, first try. At the old rate (1 in 80 in Firefox) no
  failure in 80 is a 37 % chance by itself; the deterministic red above is the receipt.

## Fix
A page a service worker already serves also takes its registration from `getRegistration()`, which answers at once,
outside the job queue, and watches that: an install under way shows as `installing`, so the opening goes to
`downloading`, the app holds, the line shows and the version is taken as ticket 36 says. Whichever of the two answers
first is watched; the other is dropped. A `register()` that fails no longer ends an opening already watched.

## Left as it is
The page's own `reg.update()` at the opening goes through the same queue and may answer only after the browser's
install; nothing waits on it then, as the opening is already `downloading`.

## Comments

2026-10-11, seen alongside in the preview run of d770a63 (38178624935, against `dave-pr-44`), not this ticket's: Firefox,
`invariants.spec.ts` "a share tile left on "Opening…" while its video decodes is reported" failed once and passed on the
retry, `bob.receivingShareFrom('Alice')` false at line 31. update.spec does not run against a preview, and the fix
touches only the service worker's registration. Not looked into further; it needs its own ticket.
