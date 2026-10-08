# 03 · Red-then-green receipt: CI proves a regression test catches its bug

Status: open
Type: task

## Why
The strongest pattern in the history: a test pushed alone failed in CI, then the fix turned it green (`9a73b1a`, `4b9fe98`).
It was done by hand, once in a while. Most problem-report fixes landed without any test that would have failed before.

## What
A CI job on branches and pull requests. When the branch changes files under `src/` and also adds or changes tests
(`test/**`, `e2e/**`):
1. Take the changed and added test files from the branch head, and the `src/` tree from the merge base with master.
2. Run only those tests against the old `src/` (vitest files directly; e2e specs with `--grep` on the touched tests, one
   engine is enough).
3. Report in the job summary, per test: "fails without the change (good: it covers it)" or "passes without the change". The
   job fails only when the branch has a commit whose subject starts with `Problem report:` and none of its tests failed on
   the old code. Otherwise it is informative.
Keep it cheap: skip when there are no test changes; one engine; a timeout.

## Verify
Push a branch with a deliberately reverted fix pair (e.g. recreate 9a73b1a + 4b9fe98 on top of a scratch branch) and show
the job naming the test as "fails without the change".
