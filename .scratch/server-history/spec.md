# Spec: kept history

Decided 2026-11-03 and 2026-11-04 with the owner. Glossary `CONTEXT.md` (**Kept history**); decision
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
5. **About** shows how full the window is and how far back it reaches (owner, 2026-11-04).
6. **Migration of stored shapes**: "we will figure out something" (owner, 2026-11-03). The kept entries are the wire's
   `sealed` and `file` frames as they are; a change to those is a change to what the Store holds.

## 3. Wire

- Client → Room: `{ t: 'sync', since }` after every welcome. Room → client: `{ t: 'history', entries, last? }`, one or
  more frames, `entries` as `sealed` and `file` frames were broadcast, oldest first.
- Worker: `GET /history-usage` → `{ bytes, budget, entries, oldest, asOf }`, kept a minute per isolate.

## 4. Tickets

- 01 Texts and file announcements kept, synced on connect, the window, About.
- 02 File bytes kept, encrypted, in the same window.
- 03 Private conversations as rooms of two, kept and synced like any room (ADR 0011).
- 04 Older than the newest 500 from the server, on scrolling up.
