# 19 · Reconnect lines leave the chat

Status: resolved
From the `bug_report` events of 2026-09-20 (text, annoying, same reporter as the Sep 16 flood): "The messages like
'Reconnected after about 1 s offline. Messages sent meanwhile are missing here.' keep polluting the text chat. We
should just remove them." Ticket 18 had raised the bar to a 10 s gap, but the lines already written sat in the
browser's IndexedDB history for good, and every qualifying reconnect would have added another permanent one.

## Built
- `room.ts`: no chat line on a reconnect any more. The status pill already shows "reconnecting" and "unavailable"
  live; the `server_reconnected` event keeps the gap for PostHog. `NOTE_GAP_MS` and `note()` are gone.
- `history.ts`: the history holds texts only. Stored notes from before are dropped on read, so the next write
  removes them from IndexedDB; a friend who opens the room sees a clean history at once.
- `core/format.ts`: `formatDuration` had no other caller and is removed with its tests.
- The `system` chat line kind stays for the live "Not sent" and "Dropped" lines, which are never persisted.

## Verify
- `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Driver: `dropSocket()` then wait for the welcome; the chat gains no line, `server_reconnected` is still captured.
