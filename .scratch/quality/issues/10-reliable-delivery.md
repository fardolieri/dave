# 10 · Reliable delivery: one way for a message to survive a dropped socket

Status: open
Type: task

## Why
Almost every bug the first week's gate turned up was one bug: a message in flight while the socket to the Room drops and
comes back. Each got its own fix: offers numbered and re-sent (044c3c4, 8444326), signals held until the welcome
(273d771), ICE candidates ordered after their offer (69be876), joins re-sent with request ids (52c3fc1, 236a00b), texts
with ids, acknowledged and re-sent (1b828cb). `src/client/call.ts` grew from 1662 to 1951 lines in two weeks, and the
protocol now carries four id schemes (`TextId`, `RequestId` for join and ice, `n`/`conn`/`forConn` on signals). Messages
without a scheme still lose state across a reconnect (a rename during the handshake, noted in review on 10-10).

## What
1. **Inventory** every client→server message (`ClientMessage` in `src/core/protocol.ts`) and what must hold across a
   socket drop: a *declaration* (mute, share, name, picture, subscribe, telemetry: the latest value must win after a
   reconnect, re-declared after the welcome), an *event* (text, signal, join, leave, ice: at least once, deduplicated by
   id, never applied to the wrong request), or *best effort* (ping). Write it as a table in this ticket.
2. **One outbox** in `src/client/room.ts` that every send goes through: holds frames until the welcome, re-declares the
   latest declarations after each welcome, keeps events until acknowledged (or answered) and re-sends them on the next
   socket, drops what is superseded. `call.ts` keeps only call logic and loses its private hold/resend code.
3. **One test matrix**: for every message type, an e2e test (or a parametrised one) that drops the socket at the moment it
   is in flight and checks the outcome everyone sees; plus unit tests for the outbox in `src/core/` if its logic can be
   pure. Each existing regression test of the week must still pass.
4. **Compatibility**: friends run different app versions during a deploy (the service worker updates on the next open),
   and the Room deploys at once. Old clients talk to the new Room and new clients to old peers, so ids stay optional and
   unknown fields are ignored, as today.
5. Step by step, each on master before the next, each red-then-green where it changes behaviour, each through `/ship`
   (review + Grumpy Friend): inventory and outbox with declarations first, then events one type at a time.

## Done when
The table is complete, every message goes through the outbox, the matrix is green in both engines on a preview and on
nightly with no flakes, and `call.ts` is smaller than before.
