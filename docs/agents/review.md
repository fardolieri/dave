# Reviewing a change

For whoever reviews a diff before it lands (a review subagent, `/code-review`), and for its author weighing what came
back. `AGENTS.md` points here. The diff is `git diff origin/master...HEAD`.

## A finding

A **finding** is a sequence that breaks something: who does what, in which order, and what they then see or lose. Report
it as that sequence, with the lines it runs through, and say whether you ran it or reasoned it.

Anything else stays out of the report: a helper written twice, a name, a faster way nobody measured, a comment's
wording. Something the author already answered is a finding again only with a sequence the answer does not cover.

## Where the bugs were

What the real findings of 68 reviews were about (November 2026), the most common first. Walk each through the diff.

- **Order.** Two things that can arrive either way round: a reconnect in the middle, a card before its text, a second
  click before the first answer, a push or a deploy between two steps of a workflow.
- **Two versions at once.** A deploy reloads nobody: a friend's tab runs the old app until its update bar is clicked
  (`src/client/update.ts`), and a rollback puts old code on new data. So the old app meets the new frame or stored value,
  and the new app the old one. One field a parser does not know must not cost the whole message, and a change made by
  the old app must not wipe what only the new one keeps (`AGENTS.md`, "Saved state needs a migration story").
- **The cause it names.** A line that says why ("Tenor did not answer") has to be true on every path that shows it:
  nothing found, out of reach and refused are three causes.
- **Whose clock.** What a Room stamps is by the Room's clock (`at`, known since the welcome). `Date.now()` set against it
  is a device's clock against another's.
- **What stays behind.** A listener, timer, lock or flag taken on a path is given back on every way out of it, the
  failing ones too.
- **A throw in the middle.** Where the second step must happen whatever the first does (close the socket, tell the
  room), a first step that throws must not skip it: a storage write, or a `.then(ok)` whose `ok` throws.
- **The free plan's day.** Every request to a Durable Object, and every second one stays awake, counts against a daily
  limit, and past it the live site's rooms are down until midnight UTC (`src/core/relayusage.ts`, tickets 84 and 89).
  Count what a new poll, alarm, socket or test adds.
- **A test that cannot fail.** Would it go red with the change taken out? A pattern that matches nothing, a wait longer
  than the test's own time, a check skipped in CI.

## Settled

Looked up once, so a review does not work it out again. Each names its source; where the source has moved on, the source
is right, and this file is corrected in the same PR.

- **Browsers.** The suite runs Chromium and Firefox (`playwright.config.ts`), and the build is for current browsers
  (`build.target` in `vite.config.ts`). The friends' browsers on the live site, from PostHog (`$browser`, `$os` and
  `$browser_version` of every event, 60 days to 2026-11-19): Chrome and Brave on Linux, Android and Windows, Safari on
  iOS 26, a little Samsung Internet and Firefox, none more than a year old. A break in a current Chromium, Firefox or
  iOS Safari is a finding, and iOS Safari is proven only at rung 4. A break only in a version older than the friends
  run is not one.
- **Solid 2.** Its own rules (a read outside tracking, a write it forbids) are told by its development build, which the
  gate does not run: the suite with `VITE_SOLID_DEV=1` runs weekly, and by hand for a diff that leans on them
  (`gh workflow run e2e.yml --ref <branch> -f solid_dev=true`, on GitHub's runners, no preview). Its verdict settles what
  a reading of `node_modules/solid-js` would argue.
- **What Cloudflare counts.** Limits, shares and what a frame to a sleeping room costs are constants with their sources
  beside them in `src/core/relayusage.ts`.
