# 04 · Invariants: the app notices when its UI contradicts reality

Status: open
Type: task

## Why
The latest problem reports were all UI that disagreed with what was really happening: a share tile stuck on "Opening…" while
frames were arriving; muting a friend's share muted the friend; a friend shown offline while their voice still played. Each
was found by a friend, days later, by luck. The app has everything it needs to notice these itself.

## What
- A small watchdog in the client (`src/client/invariants.ts`, pure checks in `src/core/` where possible, unit-tested) that
  every few seconds compares what the UI says against what the WebRTC stack and the call state say. Start with the bug
  classes that already happened:
  - a share tile shows "Opening…" (or any loading state) for over 10 s while its inbound video is decoding frames;
  - a friend's voice gain or mute state in the audio graph differs from the controls shown for that friend (voice and share
    separately);
  - the roster in the call differs from the connected peer connections for longer than a grace period;
  - the call indicator/tab title count differs from the participants;
  - a connection shown as connected whose transport has been failed or closed for longer than a grace period.
  Grace periods matter: transitions are legal for a moment. False positives are worse than misses: each one must be quiet in
  a normal call.
- A violation is reported once per kind per call: a PostHog event `invariant_violation` (kind, duration, a compact snapshot
  in the style of `diagnostics.ts`, no names or texts), with the same consent rules as other quality events, and a console
  warning `[invariant] …`.
- In e2e (hooks on): the inspection hooks expose violations, and `e2e/fixtures.ts` fails any test in which an invariant fired
  (the same way it fails on unexpected console warnings), unless the test declares it expected. So every existing e2e test
  becomes an invariant check for free.
- Unit tests for the pure checks; an e2e test per invariant that forces the bad state through the hooks or the wire proxy
  and sees it reported.

## Verify
Rung 2: the whole e2e suite green with the watchdog on (no false positives), plus the new tests.
