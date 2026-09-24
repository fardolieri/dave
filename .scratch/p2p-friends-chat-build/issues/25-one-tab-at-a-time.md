# 25 · One tab at a time, the first one keeps working

Status: shipped 2026-09-24 to nightly and prod (9187203, review fix 3e34991)
Asked for 2026-09-24: "when opening dave in a second tab the first one becomes stale. I want to change that behaviour.
When the app is already open i want newer tabs to display that information (already open) and keep the old tab
working." Approach from another session (Web Lock in the browser, server unchanged, take-over button kept, one lock for
the whole app); then "I want you to do all of it".

## Built
- `client/tablock.ts`: the tab state `checking | held { mayRejoin } | waiting` around the Web Lock `dave-tab`.
  - At load the tab queues for the lock. Granted within 2 s: it runs the app and may Rejoin (a reload frees the old
    page's lock a moment after the new page asks). Not granted: the notice, and the request stays queued, so the tab
    takes over by itself when the other one closes, with `mayRejoin` false: it must not pull you back into the call
    you left by closing that tab.
  - "Use it here instead" steals the lock. The tab it was stolen from runs its step-back hooks first, so its call
    sends `leave` while the socket is still open (others see a clean leave, not "connection to server lost"), then
    unmounts its workspace and queues again.
  - A reload of the tab holding the lock steals it back: without that, a waiting tab ahead in the queue inherited the
    app, and the call, from a refresh (reproduced). Told by a per-tab sessionStorage flag and navigation type `reload`;
    the dying page ignores the steal (pagehide), so it cannot leave the call or remove the Rejoin marker.
  - No Web Locks: behaves as before; the server's 4004 rule and the "open in another tab" banner stay as the backstop.
- `App.tsx`: the workspace renders only while the lock is held; the notice otherwise. `storage` events carry rooms,
  the selected room and the name from the waiting tab, so an invite link opened in a new tab lands in the running one.
  The workspace keys its rooms by secret, so a link that renames a room already here (found in review: the rename
  made a new object, which rebuilt the room and dropped its call, in the same tab too) only changes the name.
- `call.ts`: `createCall` takes `mayRejoin`; the Rejoin marker is ignored without it.
- PostHog: `tab_waiting`, `tab_taken_over`.
- Spec §4 (one socket per identity), amended.

## Verify
- `pnpm typecheck`, `pnpm test`, `pnpm build`.
- `TABS_CHECK=1 node scripts/drive.mjs --join http://localhost:5199 <secret> Alice Bob Carol` against `pnpm dev`,
  2026-09-24: tab 2 shows the notice and has no workspace, tab 1 stays in the call and Bob sees Alice once. Tab 1
  reloads while tab 2 waits: tab 1 is back in the call, tab 2 still waits (without the reload steal, tab 2 got the app
  and the call was lost: checked by switching it off). A room written by tab 2 shows up in tab 1 with the call intact.
  Tab 2 takes over: tab 1 shows the notice, the marker is gone, Bob sees Alice leave cleanly. Tab 2 joins, then closes:
  tab 1 takes over by itself and is not in the call; Bob sees the usual grace for a closed tab.
- `DEFAULT_AUTOPLAY=1 REJOIN_CHECK=1` (ticket 24) still passes with the lock in place.
- Not tried: Firefox, a phone.
