# Spec: attachments

Decided 2026-10-15 with the owner. Glossary `CONTEXT.md`; decision [ADR 0006](../../docs/adr/0006-files-announced-through-the-room-and-pulled-peer-to-peer.md).

## 1. Goal

Friends send photos, GIFs, videos and other files into a room's chat. Pictures and videos show inline; other files are a
card with a download button. Later, files of any size. No cloud storage: the Room carries a sealed announcement, the bytes
go from friend to friend.

## 2. Decisions

1. **Announce, then pull** (owner, 2026-10-15). The writer sends a sealed `file` frame with name, type, size, hash and a
   preview; friends pull the bytes over a file link to the writer (later: to anyone who has them).
2. **Originals unchanged**, metadata included (owner). Only the preview is made: 160 px on the long side, WebP or JPEG, a
   few KB, inside the announcement.
3. **Pulled by itself or on a click** by size: pictures and videos up to 16 MB by themselves, anything else on a click; a running pull can be
   cancelled, and then waits for a click.
4. **Kept in the browser**, by hash, in IndexedDB, within 300 MB; the oldest go first. No cloud store yet.
5. **100 MB per file** until files stream to disk (ticket 03).

## 3. Wire

- Client → Room: `{ t: 'file', sealed, id }`. Room → friends: `{ t: 'file', from, sealed, at, id }`, like `sealed`.
- Client → Room: `{ t: 'link', to, data }`, Room → that friend: `{ t: 'link', from, data }`; any two attached friends.
  `data` is `{ link, description?, sig?, candidates? }`; `link` names the pull's connection.
- Client → Room: `{ t: 'linkice', id }`, Room → client: `{ t: 'linkice', iceServers, issuedAt, id }`. One-hour TURN.
- On the link's data channel: the puller asks `{ t: 'get', hash, offset }`; the holder answers `{ t: 'have', size }` and
  the bytes in chunks, or `{ t: 'none' }`.

## 4. Tickets

- [01 · Pictures, GIFs and videos pulled from the sender](issues/01-pictures-pulled-from-the-sender.md)
- [02 · Any file, from anyone who has it](issues/02-any-file-from-anyone.md)
- [03 · Files of any size, streamed to disk](issues/03-any-size-streamed-to-disk.md)
