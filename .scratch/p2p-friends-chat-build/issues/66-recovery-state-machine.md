# 66 · Connection recovery as a state machine in core, against a written table of rules

Status: shipped 2026-10-28 to prod (3e95fa5, PR #101)
Type: task

## Why
Ticket 63's fix took twelve review rounds, most of which found something real, and later rounds contradicted earlier
ones. The recovery of a connection (failure, disconnect, stuck connecting, rebuild, ICE restart, a friend's socket lost
and back, which offer goes where) was spread over eight functions of `client/call.ts`, in per-connection flags and
timers set from browser events. Nothing of it could be unit-tested, so reviews were the only cheap check, with no
written rule to check against: each reviewer brought its own.

## What
1. The rules as a table: spec §8.2, "Recovery rules", state and event to action. A review that disagrees with a row
   asks for a spec change, decided once by the owner.
2. `core/recovery.ts`: one connection's recovery state and the per-friend attempt counts, events in, actions out
   (badge, timers, restart, rebuild, close, send again); `offerPath` for where an incoming offer goes. `client/call.ts`
   keeps the browser and the timers and carries the actions out. Behaviour unchanged: the e2e suite says so.
3. `test/recovery.test.ts`: the table, row by row, and a simulation of two friends over a fake network (each with its
   machine, signals and timers on one clock) for the sequences reviews kept raising: a handshake through on one side
   only, a renegotiation while a rebuild waits, a friend on the app from before, a socket lost while a rebuild waits.

## Not in it
No change of behaviour. Anything the table or the simulation shows wrong becomes a ticket of its own.

## Found
- Ticket 67: when ICE fails at both ends of a call that was up, each side answers the other's restart from a new
  connection (O4), neither restart is used, and the call comes back by rebuilds, 10 s in the simulation. A test marked
  `it.fails` holds what it should do.
