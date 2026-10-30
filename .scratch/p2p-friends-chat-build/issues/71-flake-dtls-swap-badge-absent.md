# 71 · Flake: the DTLS swap test fails when the friend's row shows no connection badge at all

Status: open, cause known (the test)
Type: flake

Seen 2026-10-30: the preview run of PR #110 at aac957f (run 41102076892), Chromium, shard 1, passed on its retry, so the
gate to master went red: `adversary.spec.ts:15` "ADR 0004: a server that swaps DTLS fingerprints cannot get a call
connected". `expect(bob.badge('Alice')).not.toHaveText(/direct|via relay/)` at line 28 waited 20 s on "element(s) not
found".

Not the change: PR #110 adds 12px below the invite panel (`styles.css`) and a test that measures it; neither opens a call.
The ledger had no earlier sighting with this error.

Cause: the failed try's snapshot (`error-context.md` in the run's `e2e-chromium-1-41102076892-1` artifact) has Alice in
Bob's call list with no `.conn` at all. The badge shows only while the call has a view of that friend (`App.tsx`,
`ParticipantRow`), and between the watchdog's rebuilds of a connection that never comes up there is none. The test's
claim held (never connected), but `not.toHaveText` needs the badge to be there.

Fix: assert that no badge of hers says connected, e.g.
`await expect(bob.badge('Alice').filter({ hasText: /direct|via relay/ })).toHaveCount(0)`, the same at lines 29 and 46.
