# 01 · Pictures, GIFs and videos are sent into the chat and pulled from the sender

Status: shipped 2026-10-16 to prod (243728d), nightly e2e green first
Blocked by: none
Decision: [ADR 0006](../../../docs/adr/0006-files-announced-through-the-room-and-pulled-peer-to-peer.md)

**Why:** the first thing friends want to send is a photo or a clip, and to see it in the chat.

**What to build:** an attach button, paste and drop in the composer. The sender keeps the file in IndexedDB and announces
it sealed, with a preview. Friends show the preview at once, pull the bytes from the sender over a file link, check the
hash, keep the file and show it inline. Other files show as a card and are pulled on a click.

## Acceptance

- [x] `sealFile` / `openFile` in `src/core/sealed.ts`, domain `dave file v1`, with unit tests like the texts'.
- [x] Protocol and Room: `file`, `link` and `linkice`; `link` between any two attached friends; one-hour TURN for links.
- [x] File links (`src/client/links.ts`): signed descriptions, one data channel, chunked pull with backpressure, closed
  when idle.
- [x] File store (`src/client/files.ts`): blobs by hash, a 300 MB budget, listed in `src/core/storedstate.ts`.
- [x] Chat: preview, then the picture or video inline; a card for other files; "waiting for <name>" while the holder is
  offline; a picture opens full size on a click.
- [x] Browser test: Alice sends a picture, Bob (a visitor) sees it inline with the same bytes.

## Not in this ticket

- Pulling from anyone but the sender (ticket 02), files over 100 MB (ticket 03).
- Keeping an unsent file over a reload: unlike a text, it is forgotten (it is sent again on the next socket otherwise).
