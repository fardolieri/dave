# 70 · Flake: a badge left on "direct" over a closed connection was not reported within 30 s

Status: open, cause not known
Type: flake

Seen 2026-10-29: the preview run of PR #104 at 65e0191 (run 40953129959), Chromium, shard 3, passed on its retry, so the
gate to master went red: `invariants.spec.ts:64` "a badge left on "direct" or "via relay" over a closed connection is
reported (conn_transport)". `expect.poll(fired(alice), { timeout: REPORTED_WITHIN })` at line 72 waited 30 s and saw no
invariant at all (`[]`, not `['conn_transport']`).

Not the change: PR #104 retires nightly and prod (workflows, docs, the briefing); its only lines in the app are comments
and the build target's name for nightly, which a preview never had. The same code passed the branch's local run in both
engines and all the other shards of that preview run. The ledger had no earlier sighting with this error (two rows of
2026-10-15, 6e1d2cb, failed on `toBeEnabled` instead).

To find: whether the invariant watchdog misses a connection closed quietly (`closeQuietly`) when the badge has not
settled yet, or the poll starts before the badge says "direct" at all on real Cloudflare latency. The failed try's trace
is in the run's `e2e-chromium-3-40953129959-1` artifact (14 days).
