# 04 · Invariants: an attachment never says it is coming when nothing can bring it

Status: shipped 2026-10-16 to prod (5ec0b8a), nightly e2e green first
Blocked by: 01
Asked by: the owner, 2026-10-16, after the reports of that day ("Try again keeps being at 0%")

**Why:** both of the day's reports were the chat saying something the pulls underneath contradicted. The call has a
watchdog for that (`src/core/invariants.ts`, quality ticket 04): a contradiction that holds past its grace fails every
e2e test and is reported from the field as `invariant_violation`. Attachments have none.

**What to build:** a watchdog per room, running while the room is open, in or out of a call, with two kinds:
- `file_pulling_stuck`: an attachment shows a pull under way (`pulling`), and no bytes have come for longer than the
  pull's own give-up (connect 20 s, stall 20 s), or no pull of it is running at all.
- `file_waiting_online`: an attachment says it waits for someone to come online while one who has it is in presence.

Both count only after a grace longer than any legal transition; a false alarm is worse than a miss (as the call's).

## Acceptance
- [x] The rules in `src/core/invariants.ts` (pure), unit-tested like the call's.
- [x] The room watchdog in `src/client/`, reporting `invariant_violation` with `kind` and a snapshot without names.
- [x] A browser test that breaks each on purpose (through the inspection hooks) and sees the violation.
