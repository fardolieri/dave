# 36 · A new version found as the app opens is taken by itself, behind a thin progress line

Status: built 2026-10-01, not yet deployed
Asked for 2026-10-01: Daniel: "When opening the app though it feels weird to immediately manually reload the page when I
just opened it." A new version found as the app opens freezes the app (Join disabled, as while it connects), shows a slim
download progress line at the top and reloads by itself when the download is done. Online friends may show meanwhile;
joining a call may not. Decided with Daniel the same day: the freeze lasts at most 10 s, the composer is frozen too (a
half-typed line would be lost to the reload), and the line lies over the page, no layout shift, nothing to click.

## Scope
- As the page loads, if a service worker already serves it (not the first visit), the app asks for a newer version
  at once and waits for the answer (at most 3 s; offline or a slow server lets the app go on as before).
- A new version found then, or one already installed and waiting from before (a reload of your own while the update bar
  was up), is downloaded while the app is frozen: rooms connect and show who is online, but Join, the composer and a
  Rejoin after a reload (ticket 24) wait. A thin line across the top of the page shows the download's progress in
  bytes, counting only what changed (files an earlier version already has are copied, ticket 33).
- Once it is installed, the new version takes over and the page reloads by itself; a call left by the reload is rejoined.
- The freeze lasts at most 10 s from the page load. Past that, or if the download fails, the app unfreezes on the
  version it has; a download still going finishes in the background and the update bar of ticket 33 asks as before.
- Only the tab that runs the app (ticket 25) takes the update. A tab that ends up waiting behind another does not.
- A version found later in the session still shows the update bar of ticket 33, unchanged.

## Built
- `client/update.ts`: `opening` (`checking` → `downloading` → reload, or `over`) and `holding()`. Only a page a worker
  already serves starts in `checking`; it calls `reg.update()` and ends the opening if nothing new comes back, or no
  answer within 3 s (`OPEN_CHECK_MS`). An `installing` worker (the browser's own check at the load may have found it
  first) moves it to `downloading`; an installed one, or one already `waiting` at the load, is taken: `skip-waiting`,
  and `controllerchange` reloads, as the bar's Reload does (`takeOver`, shared). `OPEN_FREEZE_MS` (10 s, counted from
  the page load with `performance.now()`) ends a download still going; `redundant` (a failed install) ends it too; the
  bar then asks once a version is installed, as in ticket 33. `tabSettled(held)`, called by `App.tsx` once the tab
  lock has said, is what lets it reload: a tab that ends up waiting ends the opening instead. Events:
  `update_taken_on_open` (with the ms since the load), `update_on_open_too_slow`.
- `client/sw.ts`: the install reports `{ type: 'install-progress', done, total }` to every window (uncontrolled ones
  included), at most ten times a second and once at the end. `total` is the size of the files it downloads, not those
  copied from an earlier version; `done` counts bytes as they stream in, read from a clone while the original goes into
  the cache. `vite.config.ts` writes each file's size into `__PRECACHE__` (`sizes`, aligned with `urls`).
- `client/App.tsx`, `styles.css`: `UpdateLine`, `position: fixed` at the top, 3 px, the accent on a 25 % track, no pointer
  events, a `progressbar` role with the percentage; shown while `downloading`, not in a tab that waits. While
  `holding()`: rooms get `frozen` (as while connecting), Join is disabled with the title "A new version of dave is
  loading", the composer is disabled with that as its placeholder.
- `client/call.ts`: `holdRejoin` option; the Rejoin after a reload waits until the room is connected and nothing holds
  it. The reload for the update then rejoins: the marker is at most a few seconds plus the 10 s freeze old, inside
  `REJOIN_WINDOW_MS` (30 s).
- Browser suite: the preview server takes `e2e-throttle=<bytes per second>` (`vite.config.ts`, `throttle`: by the clock,
  so the rate holds whatever size the chunks come in; the first cut slept per chunk and ran at 650 kB/s instead of
  1.5 MB/s). A big deploy is staged by deleting RNNoise from the running version's cache, so the new one downloads it.
  `FriendOptions.video` records a friend's screen (the videos below).
- Ticket 33's test lost its "a reload of her own keeps the bar" step: such a reload now takes the waiting version.
  Firefox gets there in one load (its waiting worker takes over during the reload, the last page of the old one gone),
  Chromium in two; the test checks where it ends, not the count.
- Found in the videos after rebasing onto master: a small update stayed frozen with a full line for 5 s. The new worker
  got `skip-waiting` at about 80 ms and called `skipWaiting()`, but Chromium held the activation back while the version
  before still counted as busy from the page load, and checked again only at the 5 s fallback reload. Half of the runs.
  Reloading on an answer from the worker at once was too early (served by the old version, a third load); a reload from
  500 ms on was always served by the new one. `TAKE_OVER_FALLBACK_MS` is now 1 s for both paths, the bar's Reload too
  (mid-session the old worker is idle, `controllerchange` comes first). Six runs: one `skip-waiting` each, the new
  version activated by 1.1 s at worst.
- Spec §2.5 extended.

## Changed the same day: no friends while it downloads, and the line for every download
Daniel, after the videos: "Lets not show friends during the page-load-download (either dont connect or just dont show
in list, whatever is easier to implement). I think this will reduce the stutter and layout shift." From nobody →
download with friends → reload → nobody → friends, to nobody → download → reload → nobody → friends. And: "lets keep
showing the download bar even when we exceeded the 10 second period to be consistent with always showing the download
progress", which takes in the line for downloads a later check starts (asked about just before).
- `client/room.ts`: `hold` option; the first `open()` waits until it is false. The rooms pass `holding`, so while the
  app checks or downloads at the opening no socket opens: no friends, no Join, no Rejoin, and friends do not see this
  browser come, go and come back. Not connecting was as easy as hiding the lists and saves that blink too.
- The rooms now wait for the opening check on every load, not only with a new version: `OPEN_CHECK_MS` 3 s → 1.5 s
  (Daniel). Usually one small request; master's quiet first connection (2.5 s before the pill) now counts from when
  the rooms may connect, so a long download never shows "Connecting…".
- `client/update.ts`: `downloadProgress`, its own signal, apart from `opening` (now `'checking' | 'downloading' |
  'over'`). Set by the progress reports while a worker installs, whatever found it; cleared at `installed` (the bar asks)
  or `redundant`; kept full for the opening update until its reload. The line (`App.tsx`) shows it in any tab but a
  waiting one, so past the 10 s it goes on over the app connected, and a later check's download shows it during a call.
- Found in the new videos: the first install, on a page nothing served before, set the line and never cleared it (a
  first install never waits, so nothing reached the clearing). It is no new version: `downloading` ignores an install
  into an uncontrolled page, and `installed` clears the line unless the opening takes it. Ticket 33's test now also
  checks that the first install shows no line.
- Tests: the opening test checks no socket is open while it downloads (`Wire.open`) and no friend shows; the 10 s test
  that the line goes on past the hold and goes when the bar comes; a new test for a later check's download (the line,
  the app not frozen, then the bar, no reload). Videos re-recorded, with a sixth: a later check during a call.

## Verify
- `pnpm typecheck`, `pnpm test`; `e2e/update.spec.ts` in Chromium and Firefox: before the rebase 3× (36/36), after it
  and the fallback fix 2× (24/24). Before the rebase the full suite in both engines had two failures: this ticket's
  one-load Firefox reload (fixed above) and ticket 23's join cue in Firefox, which also fails 1 in 3 alone and is
  known Firefox noise (ticket 33's notes). After the rebase and the fix, the full suite in both engines: 103 passed,
  6 skipped, 1 failed, the same ticket 23 cue in Firefox, which fails 1 in 3 on master too.
- Videos (`.scratch/p2p-friends-chat-build/demo-36`, `pnpm exec playwright test -c` that folder; the videos stay out of
  git): a big update on desktop and on a phone, a reload in a call that rejoins, a typical small update, and a slow
  line that gives up after 10 s and ends in the bar.
