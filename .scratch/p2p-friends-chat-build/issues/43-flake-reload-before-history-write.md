# 43 · Flake: a reload right after a line shows loses it from the history

Status: shipped 2026-10-12 to nightly and prod (prod 961c90a, nightly e2e green first); fixed on branch flake/text-reload (PR #43), 2026-10-11; outcome 1 of ticket 35 (the test is wrong)
Seen 2026-10-11: e2e run 38169890832 (local build, branch fix/send-on-closed-socket, PR #42), job 114560098813,
Firefox: `text.spec.ts` "received history survives a reload, and "Clear chat history" empties it" failed on its first
try and passed on the retry. After the reload Bob's chat held "one" without "two" for the whole 20 s poll (line 62).
The other three runs of PR #42 (38170369815, previews 38169894475 and 38170373563) did not retry it.

## Cause
The gap ticket 35 already names and accepts for the app (flake 3, decided with Daniel 2026-09-30): a chat line shows
when the Room's broadcast comes back (`client/room.ts`), and its history write (`appendHistory` in `client/history.ts`)
starts then and ends a moment later: it opens the database, reads the room's list, opens it again and writes. Writes
are chained, so "two" waits behind "one". A reload in that moment loses the line, as if it had come a moment earlier;
the sender still has it.

The test reloaded the moment "two" showed, so it claimed more than the app promises. "two" was Bob's own line, the
last one, its write the furthest behind; Firefox's IndexedDB on a busy runner is the slower of the two engines.

## Regression test
`Friend.slowStorage(ms)` (e2e/fixtures.ts) makes a page's IndexedDB slow until it goes: every database it opens answers
`ms` later. The app opens the database for each read and write (`client/storage.ts`), so a history write ends seconds
after its line. The flaky test runs with Bob's storage 1.5 s slow; that turns the rare gap into every time.
- Red, on the test alone (ac8fb94): e2e run 38176731504, both engines failed on both attempts at the check after the
  reload, Bob's chat empty; the preview run of the same commit (38176780181, against `dave-pr-43`) the same. The ci run
  of that commit (38176731497) failed too, on two unit tests in `test/worker.test.ts` in the nightly env (a rate-limit
  test timing out, a second auth answered with presence first): not this change, which touches only e2e/; see below.
- Green with the fix (babfe6e): e2e run 38177486467 and the preview run 38177489737, both engines, every job passed
  with no test retried.

## Fix
The test waits for the write before it reloads: `Friend.storedTexts()` reads every room's history from IndexedDB, and
the test polls it for "one" and "two" first. The "Clear chat history" half needed nothing: the app empties the chat
only after the history write (`clearHistory` in `client/room.ts`), so it already held with slow storage. The leave-room
test had a gap of the same kind: leaving drops the room from the list at once and deletes its history a moment later
(`forgetRoom` in `client/rooms.ts` does not wait), and the link the test opens right away brings the room back on the
same page (a fragment change), whose history load (`client/room.ts`) is not queued behind that delete. It now waits for
the stored history to be empty, and (added after review) for "before" to be written first, so that the empty history
is the delete's. Not seen to flake; same cause, same fix. No app change, so the fix commits are not "Problem report:"
and the red-green job has nothing to judge: the red receipt is the e2e run above.

## Left as it is
The app gap itself, as ticket 35 decided. Leaving a room has the mirror image: a link to the room opened in the moment
after leaving (or a reload then) can bring back the history the leave dialog says is forgotten. A person cannot be that
fast after the dialog; not worth a change unless it is seen.

Seen alongside, not this ticket's: the ci run of the red commit failed on `test/worker.test.ts` "rate-limits upgrade
attempts per IP" (timed out in 5 s) and "after authentication a second auth is refused" (got presence where it
expected the error), nightly env only, prod env green. The same tests passed on the fix commit. A flake of its own,
needs its own ticket.
