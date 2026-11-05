# Spec: kept history

Decided 2026-11-03 to 2026-11-08 with the owner. Glossary `CONTEXT.md` (**Kept history**); decision
[ADR 0009](../../docs/adr/0009-one-store-keeps-every-rooms-sealed-texts-in-one-window.md).

## 1. Goal

Persistent, synced chat: the server is an always-on peer that keeps what friends send and hands it to whoever missed it,
a friend who was away or a new device. It keeps only sealed data and cannot read it. No server-side search; search, if
any, in the browser.

## 2. Decisions

1. **Encrypted only** (owner, 2026-11-03). The server keeps texts and file announcements as sealed today (ADR 0005, 0006);
   file bytes, when kept, encrypted with the text key before they leave the browser.
2. **One window for all data combined** (owner, 2026-11-04): texts and files of every room together, oldest dropped first.
3. **4 GB**: 80 % of the free plan's 5 GB of Durable Object storage (the owner first said 8 GB, as 80 % of a 10 GB limit;
   the free plan has 5 GB for the account). A test on 2026-11-04 put 4.5 GB in one object without an error.
4. **One Store object** holds it all, so the window needs no coordination between rooms.
5. **About** shows how full the window is and how far back it reaches (owner, 2026-11-04), and today's use of the
   history's daily shares of the free plan.
6. **Migration of stored shapes**: "we will figure out something" (owner, 2026-11-03). The kept entries are the wire's
   `sealed` and `file` frames as they are; a change to those is a change to what the Store holds.
7. **Four weeks at most** (owner, 2026-11-08): the server and every browser keep 28 days, or less once the 4 GB (the
   server) or the browser's share of its storage is full. The Store prunes what is older daily, near 23:45 UTC, with what
   is left of the day's share of writes; what it could not prune it prunes the next day.
8. **No cap on a browser's texts** (owner, 2026-11-08): a browser keeps every text of the window. A long absence syncs in
   pages, one after another without being asked; "Show older messages" only unfolds what the browser already holds.
9. **A history starts at join** (owner, 2026-11-07): a browser that joins a room by its link gets nothing from before,
   and Clear moves its start to now. Clear can also delete everything I wrote in that room from the server, files with
   their bytes; friends' own copies stay.

## 3. Wire

- Client → Room: `{ t: 'sync', since }` after every welcome. Room → client: `{ t: 'history', entries, last?, upTo?, more? }`,
  one or more frames, `entries` as `sealed` and `file` frames were broadcast, oldest first; `more` when the answer stopped
  short (core/kept.ts, SYNC_MAX and SYNC_BYTES_MAX), and the client asks on from `upTo`.
- Client → Room: `{ t: 'forget', before }`; Room → client: `{ t: 'forgot', before, done }`.
- File pieces: `{ t: 'piece', tag, n, sealed }` up, `{ t: 'fetch', tag, n }` and `{ t: 'piece', … }` back (1 MB each).
- Worker: `GET /history-usage` → `{ bytes, budget, entries, oldest, asOf, today?, shares? }`, kept a minute per isolate.

## 4. Tickets

- 01 Texts and file announcements kept, synced on connect, the window, About.
- 02 File bytes kept, encrypted, in the same window.
- 03 Private conversations as rooms of two, kept and synced like any room (ADR 0011).
- 04 Older than the newest 500 from the server, on scrolling up: dropped (decision 8).
