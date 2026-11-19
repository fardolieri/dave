# dave: working agreement for agents

dave is a friends-only chat app: rooms with text, voice and screen share over a peer-to-peer WebRTC mesh, with a Cloudflare
Worker and one Durable Object per room doing only signaling and presence. Start with `README.md` (how to build, test, deploy),
`CONTEXT.md` (the words we use) and `docs/adr/`. Tickets live in `.scratch/` (`docs/agents/issue-tracker.md`).

The owner (Daniel) drives this repo remotely, mostly from a phone, and checks in every few hours. Every report you write is
read on a small screen by someone who did not watch you work: lead with the outcome and the verification level reached.

## Before any work

1. Read the session briefing (`scripts/claude/session-start.sh`): a warning there comes before new work. What stands
   behind most of them: `docs/agents/watchers.md`.
2. `git fetch origin` and start from `origin/master`: a new branch (`git switch -c <topic>/<slug> origin/master`), or the
   one your harness made, rebased onto it. Compare, diff and review against `origin/master` too: the local `master` is
   often behind, and in a worktree it is another checkout's.
3. Work on that branch, never on master directly: master takes only commits whose PR's gate passed.
4. Another agent session may be running in this repo at the same time (the briefing says so). Stay on your branch, and
   fetch before every push: master moves under you.

## Testing: GitHub Actions is the receipt

What the dev box can run locally depends on the machine: see `~/.claude/CLAUDE.md`. Whatever runs locally, the verdict
that counts is CI's: `ci.yml` and `red-green.yml` on the branch, and the browser suite (`e2e.yml`), the gate, started by
hand once the PR is meant to land: `gh workflow run preview.yml --ref <branch> -f pr=<n>` (`--ref`: the branch's own
workflows, not master's). Push a branch, open the PR and read its results.

- **The gate is run once per landing, not per push.** Each run costs some 7,000 of the previews' requests to Durable
  Objects (`RUN_COST`, ticket 89) and 18 runners. Start it when the PR is done, rebased and reviewed; a push to the PR
  cancels a run under way. It goes against the PR's preview, real Cloudflare, while the previews' share of the day has
  room for it, and against a local build of the PR on GitHub's runners when it has not (`scripts/gate-mode.mjs`): either
  writes the gate's status, and either lets the PR land. Never set that status by hand. A gate whose shards fail with
  "Today's server time is used up" (4007) ran out of the previews' share under way: start it again rather than
  re-running its failed jobs, which would go to the preview again.
- **A draft PR gets no verdict.** Its pushes end green with `ci.yml` and `red-green.yml` skipped (`draft-gate.yml`);
  marking it ready runs both on its head. `night-shift/*` branches always run them.
- **Wait for CI the way your harness says.** With no word from it, one waiting loop, never several watchers.
- **A flaky test is a bug in the app or in the test, never noise.** A test that went red where the change explains
  nothing (the 4007 above is explained): read `docs/agents/flakes.md` before any re-run. It allows one, and says when.
- Leave nothing running at the end of a turn (vite, workerd, chrome, firefox, playwright). The stop hook holds a Claude
  session to it; another session's are its own.
- Prefer one branch worked on in sequence over many in parallel: CI's 20 runners are the shared bottleneck.

## Definition of done: the verification ladder

Every change climbs this ladder, and every report says which rung it reached, in these words:

| Rung | Means | Where |
|---|---|---|
| 0 typed | `pnpm typecheck` passes | here or CI |
| 1 unit | `pnpm test` passes | CI (`ci.yml`) |
| 2 browser | the e2e suite passes against a local build, both engines | by hand: `e2e.yml` from the Actions tab (Chromium alone here is not this rung: say so). Rung 3 covers it |
| 3 preview | the e2e suite passed against the PR's preview, both engines, real Cloudflare, and its `@local` tests against a local build of the PR: the gate to master. With the previews' share of the day used up, the gate runs it against a local build of the PR instead: that is rung 3 (local), not real Cloudflare: say so | CI (`preview.yml`, started for the PR) |
| 4 seen | a human or a recording looked at the real thing (real browser, real device for phone features) | owner, or a recording |

Rules:
- **Say what you did not verify.** "Verified: rung 2. Not verified: on a phone." is a good report. A check on a copy, a
  mock, a modeled timeline or a test page is not the real thing: name it as what it is.
- **"Verify it works" from the owner means rung 2 at least, and rung 4 for anything visual.**
- **Bug fixes start red.** A problem report gets a regression test that fails without the fix, in CI. Commit the test
  ("Regression test: …") with any hook or helper it needs (`src/client/hooks.ts`, `e2e/fixtures.ts`), then the fix
  ("Problem report: …"), and push both together: a test pushed alone goes red, and every red run emails the owner.
  `red-green.yml` runs the tests of those two commits against the app from before the branch, and the rest of CI must
  be green. It fails a "Problem report:" commit with no test that fails there, unless the commit's body has a line "No
  regression test: <reason>" (for bugs no test can reach), and calls a test that fails on a missing hook inconclusive.
  Push the test alone first only when `red-green.yml` cannot show the bug: it runs browser tests in Chromium only,
  against a local build, once. A bug that needs Firefox or real Cloudflare goes red alone first, through the gate
  started on its PR with `-f mode=preview` (for Firefox alone, `gh workflow run e2e.yml --ref <branch>` also does). Wait
  for that red run to finish before the next push, which would cancel it, and say why in the report.
- **Review before the first push to master**, not after: an independent review subagent (or `/code-review`) on the
  diff, `origin/master...HEAD`. Past reviews found real bugs every time they ran. Reviewer and author both read
  `docs/agents/review.md` first: what a finding is, where the bugs were, and what is settled.
- **Saved state needs a migration story.** Anything in `localStorage`, IndexedDB or a Room's storage outlives a deploy:
  changing a default or a stored shape does not reach existing data by itself, and no preview meets old data (they start
  empty), so the live site is the first place a migration runs. Either migrate, or say plainly in the report who will not
  see it. A migration writes a new key and leaves the old one as it was, so a rollback still finds its data; deleting the
  old key is a later change, once the migration is known to work. Every stored key is listed in `src/core/storedstate.ts`
  with its parser and fixtures. `test/storedstate.test.ts` fails on a changed default or shape and says what to do.
- Never invent commit hashes, test counts or CI results. Copy them from the output.

## Shipping

Every change goes through a ready PR. A push to master deploys the live site, and GitHub accepts only a fast-forward to
a commit with the `preview e2e passed` status, which the gate's run writes on its head (rung 3). So: rebase, review,
start the gate (`gh workflow run preview.yml --ref <branch> -f pr=<n>`) and wait for it, `git push origin HEAD:master`,
then check that `deploy` passed (it waits until the site serves the commit; a commit that changes only tickets, docs or
tests has no run to check, `deploy.yml`'s `paths`, and the site stays on the last commit that changed the app). A full
send ends there; a full stop ends with the PR ready and rung 3 reached. A bad deploy: `rollback.yml` from the Actions
tab, then a fix. Prefer small PRs, squashed into one commit per idea.

## Code

- Match the surrounding style: comment density, naming, the plain prose of the existing comments and commit messages.
- `src/core/` is runtime-neutral and unit-tested; keep DOM and SDK code in `src/client/` (enforced by
  `scripts/check-core-isolation.mjs`).
- Commit messages: a sentence-case subject that says what is true now ("Muting a friend's share no longer mutes the friend"),
  a body explaining why when it is not obvious.
