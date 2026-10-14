# 10 · Reliable delivery: one way for a message to survive a dropped socket

Status: step 1 (declarations) shipped 2026-10-14 to prod (3a4474e, PR #55); step 2a (heartbeat, texts queued while reconnecting and kept over a reload, socket-end data) shipped 2026-10-14 to prod (accda12, PR #57); server-side catch-up declined by the owner for now; signals, ice and leave still open
and over a reload, drop instrumentation) on branch `quality/10-step2a`; later steps open
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

## Inventory

Every `ClientMessage` as of step 1 (branch `quality/10-outbox-step1`): what happens when the socket drops while it is in
flight, or when it is written before the welcome. "Before the welcome" means `send` in `client/room.ts` writes nothing (the
Room would count any frame but the auth as a failed answer). "Before the join" means the socket is let in but the Room has
this friend as a visitor: `core/room.ts` refuses `signal`, `ice`, `share` and `subscribe` with "not in the call" (a
`share` or `subscribe` refusal shows in the chat as "Dropped: …"), and drops `mute` silently.

| Message | Kind | Guarantee today | Where |
|---|---|---|---|
| `auth` | handshake | One per socket, in answer to its challenge; carries the latest name, picture and opt-in. A socket that does not get its welcome within 10 s is given up and the next one answers its own challenge. | `client/room.ts` (challenge, `HANDSHAKE_TIMEOUT_MS`); `core/room.ts` (3 strikes, then close) |
| `telemetry` | declaration | Latest wins: the auth carries it; a change during the handshake goes out after the welcome. | outbox: `core/declarations.ts`, `client/room.ts` |
| `name` | declaration | Latest wins: the auth carries it; a change during the handshake goes out after the welcome. **Was lost** when made after the auth went out and before the welcome (review on 10-10); fixed in step 1. | outbox |
| `picture` | declaration | As `name`; the same gap, fixed in step 1. | outbox |
| `mute` | declaration (in the call) | Latest wins: every join carries it, and a change goes out once the join is on the socket. Before, a change after the join went out and before its answer was not sent (call.ts sent it only once `joined`), a window the Mute button does not show in today; closed in step 1. | outbox; call.ts declares it at each change and once before the first join |
| `share` | declaration (in the call) | Latest wins: every join carries it, and a change goes out once the join is on the socket (before, a change in the window between welcome and join was refused with a chat line). | outbox |
| `subscribe` | declaration (in the call, one per sharer) | Latest per sharer wins: said again after the answer to every join, to friends listed as sharing in the call; forgotten when the sharer stops or leaves, and on my leave. call.ts also asks again when a connection comes up or appears (a rebuilt connection on the sharer's side drops the subscription). An ask that went out on a socket that dropped under it left the tile watching and black until the black-share watchdog asked again (`reportBlackShare`, 4 s after a watched tile stays black; seen in CI while trying to write a red test for it); since step 1 it is said again with the join's answer. A Stop watching lost the same way was never said again, and the sharer went on sending (Grumpy Friend review); fixed in step 1. | outbox; `call.ts` keeps the intent (`watchIntent`, the Rejoin marker) and the tile state |
| `text` | event | At least once, deduplicated: random `TextId`, kept until the Room echoes it back or refuses it, sent again after every welcome, shown once per writer and id. Since step 2a a text written while the socket is away waits for the next welcome (the composer stays usable while reconnecting), shows as waiting until it comes back, and is kept in `localStorage` (`dave.unsent`), so a reload sends it again with its id. Gaps: a refusal is matched to the oldest waiting text by order; a friend who reloads between the two copies of a re-sent text shows it twice (her history has no ids). | `client/room.ts` (`sendText`, `unconfirmed`, `seenTexts`), `core/unsent.ts`, `client/history.ts` |
| `join` | event (request) | At least once, answered by id: `RequestId`, 8 s wait, sent again with the same id on a socket that came back (`joinAgain`); a friend already in the call joins again after every reconnect (`redeclareAfterReconnect`). The Room answers every join (a fresh join sequence) and drops an answer whose join was left meanwhile (`settleTurnUser`). | `call.ts` (`askServer`, `declareJoin`); `client/room.ts` builds the frame (`room.join`) from the declarations |
| `leave` | event | At most once, no answer, never sent again. Lost with a socket it does no harm in presence (the next socket starts as a visitor), but peers get no `left`, so they keep the connection for the grace period instead of closing it at once, and the TURN users are not revoked (they wait for the next join or run out). | `client/room.ts` (`room.leave`), `call.ts` |
| `signal` | event | Held until the join is on the socket (`room.inCall`). A description is numbered (`n`, `conn`, `forConn`); an offer still unanswered is sent again after my reconnect's join is answered and when the peer comes back (`resendOffer`), with the candidates gathered so far inside it. Loose candidates are not sent again. Refused (rate limit, peer not in the call): logged, not sent again. | `call.ts` (`sendSignal`, `resendOffer`, `onSignalNow`) |
| `ice` | event (request) | At most once, answered by id: only on a socket in the call; `RequestId`, 5 s wait, then the restart goes on with the old credentials and the next restart asks again. | `call.ts` (`requestIce`) |
| `ping` | heartbeat | Every 30 s on any open socket, answered at the edge without waking the Room. Since step 2a, two pings in a row with no frame after them give the socket up (closed with 4009, reported as `pong_overdue`), at the tick after the second; a tick more than 75 s late never does. | `core/heartbeat.ts`, `client/room.ts`, `worker/room.ts` (auto-response) |

**Still without a guarantee after step 2a:** `leave` (at most once, no answer), loose ICE candidates and refused signals
(never sent again), `ice` (at most once, a lost one waits 5 s), text refusals matched by order, and texts the Room sent
into a dead socket (the reader's side: the Room keeps none, an open owner decision, ticket 54).

## For later steps

Input from the coordinator during step 1, not built there:
- From the review behind PR #54 (ticket 53), gaps in today's text resend queue, found by reading the code and not yet
  run: (a) a page reload loses a text not yet confirmed; (b) a friend who reloads can see a re-sent text twice; (c) a
  socket that goes silent without closing is never noticed (no heartbeat timeout, although `ping` exists).
- Decided by the lead: a text written while the socket is reconnecting is accepted and queued in the outbox, not left
  disabled in the box. The composer stays usable, and the text goes out once the welcome arrives. Open draft PR #1
  touches the same thing; the outbox replaces it.
- Grumpy Friend review of step 1 (red on master and on step 1, not built): a viewer whose socket is away while the sharer
  stops and starts again misses the presence that ended the share, so her intent (`watchIntent` in call.ts, and now the
  outbox's subscribe) survives, and the new share flows to her without a click. Presence cannot tell two shares apart;
  a share number in `Person`, repeated in `subscribe`, would.
- The network-drop root cause (sockets that close with 1006 and come back about a second later, ticket 51) is still
  unexplained. A heartbeat in the outbox would at least detect silent sockets.

Owner decision, 2026-10-14, on reader catch-up (ticket 54, "For ticket 10"): "No, not yet. I have some ideas for the
future how deal with this and more." The Room keeps no texts: no server-side catch-up, and for now no "texts may be
missing" notice either. Texts the Room sends into a dead socket stay lost for that reader.

From the reviews of step 2a, not built there:
- A phone that wakes on a socket the network cut meanwhile notices only by the heartbeat, 30 to 90 s later, while its
  first text waits. A ping at once on `visibilitychange` or `online`, given up after a few seconds without an answer,
  would shorten that, at the cost of a reconnect (and a rejoin) whenever a waking phone's network is slow.
- Two tabs handing a room over (the tab lock's backstop path only) can still send a text twice or lose one written in
  the milliseconds between the new tab reading `dave.unsent` and the old one being superseded.
- A room refused (link rotated) keeps its waiting texts, shown and stored, until it is left or let in again.
- Texts written offline go out together after the welcome; more than the Room's burst comes back "Not sent" (30 are
  kept over a reload, a live tab keeps them all).
