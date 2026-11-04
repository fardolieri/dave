# 01 · Texts and file announcements kept on the server, synced on connect, in one 4 GB window

Status: in review
Blocked by: none
Decision: [ADR 0009](../../../docs/adr/0009-one-store-keeps-every-rooms-sealed-texts-in-one-window.md)

**Why:** a text reaches only the friends online when it is sent. A friend who was away never gets it, and a new device
starts empty.

**What to build:** a `Store` Durable Object, one for the whole site, keeps every `sealed` and `file` frame a Room
broadcasts, by room. After every welcome a browser asks `{ t: 'sync', since }` from the newest text it holds less five
minutes (or from when it cleared the room's history), and opens, de-duplicates and places by time what comes back. Past
4 GB counted, the oldest entries of all rooms go. The About dialog has a line "Kept on the server: 1.2 MB of 4 GB
(<0.1%), back to 4 Nov 2026" with a meter.

## Acceptance

- [x] `Store` (worker/store.ts): keeps once per room, writer and id; `since` gives the newest N after a time, oldest
  first; past the budget drops the oldest of all rooms, no more than it must; `usage`.
- [x] Room hands over what it broadcasts (`keep`), answers `sync` from the Store in frames of about 256 KB, once per
  10 s per socket.
- [x] Client asks after every welcome, once its history is read, from where it last had everything (`historySynced`);
  what comes is opened all first, then placed by time in one go, in the chat and in its history; unread without a chime
  when the browser held some of the room, not counted when it held none.
- [x] The history's daily share of the free plan's rows (keeps, syncs, rows read), so no friend can use up the Rooms'.
- [x] Clearing a room's history keeps it cleared (`historyCleared`); leaving a room and rejoining brings back what the
  server keeps.
- [x] `/history-usage` and the About line, "Not known right now" on a failure, what was known kept over a failed ask.
- [x] An entry counts as at least what it costs on disk (workerd test against `databaseSize`).

## Verify

- `pnpm typecheck`, `pnpm test` (test/kept.test.ts).
- e2e: `text.spec.ts` "ADR 0009: a friend away, or on a new device, …", the leave test updated, `settings.spec.ts`
  "ADR 0009: About shows …", in both engines against the PR's preview.

## Not in this ticket

File bytes (02), private texts (03), older than the newest 500 (04), and sealing the writer's name inside the text.
