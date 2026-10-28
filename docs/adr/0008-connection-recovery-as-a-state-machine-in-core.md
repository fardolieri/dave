---
status: accepted
date: 2026-10-28
---

# Connection recovery is a state machine in core, and its table of rules is the spec

How a connection to a friend recovers (a failure, a disconnect, a connection stuck connecting, a rebuild, an ICE
restart, the friend's socket lost and back, where an offer of theirs goes) grew one ticket at a time (14, 22, 31, 63)
inside `client/call.ts`: eight functions, per-connection flags and timers set from browser events, none of it testable
without a browser. Ticket 63's fix took twelve review rounds; most found something real, and later rounds contradicted
earlier ones, because there was no written rule to review against, and every check of a sequence cost a CI run.

The decisions are now one state machine in `src/core/recovery.ts`, runtime-neutral like the rest of core: events in
(the browser's ICE and connection states, a timer firing, a rebuild ended, the friend's socket lost or back), actions
out (the badge, a timer to start or cancel, an ICE restart, a rebuild, a close, a send again), and `offerPath` for
where an incoming offer goes. `client/call.ts` keeps the browser objects and the timers, tells the machine what
happened, and carries out what it says. The rules are written as a table in spec §8.2, "Recovery rules", and
`test/recovery.test.ts` checks every row, plus a simulation of two friends over a fake network for the sequences
where the two sides disagree (a handshake through on one side only, an offer while a rebuild waits).

A change to recovery is a change to the table first, decided by the owner, then to the machine and its tests. A
review that finds a sequence the table handles badly asks for a row to change.

## Consequences
- Recovery is unit-tested in seconds, in CI's workerd pool like the rest of core; the e2e suite still checks the real
  browsers.
- The simulation models ICE, the handshake and signalling as far as recovery depends on them, not WebRTC: a bug of a
  browser (ticket 63's one-way voice after a restart) is still only seen in the e2e suite or the field.
