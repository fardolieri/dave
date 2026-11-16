# 84 · No room let anyone in: the day's Durable Object time was used up by Rooms kept awake

Status: fix in review (PR "The Room closes a socket once"); the watch on the free plan's use is not built yet
Type: bug, outage (reported by the owner, 2026-11-16 19:05 UTC: "is dave down? I cant reach prod")

## The outage
From 18:42 UTC on 2026-11-16 until midnight UTC every socket to a room was refused with a 500. The page itself loaded
(static files are served before the Worker runs), so it looked like a room that never connects. The Worker's
`server_upgrade_failed` in PostHog carried Cloudflare's reason from the first one on: "Exceeded allowed duration in
Durable Objects free tier." `/relay-usage` said the same in numbers: 13,216 GB-s of Durable Object time used that day,
of the Workers Free plan's 13,000 (`FREE_PLAN.compute`, core/relayusage.ts). Past the limit every Durable Object of the
account fails until 00:00 UTC, the previews' too. A rollback changes nothing about that.

## Where the time went
Cloudflare's analytics for the account (GraphQL, `durableObjectsPeriodicGroups`), by Worker: the live site's Rooms
10,106 GB-s, the previews of PRs 148, 150 and 151 about 3,000 together. A usual day is under 2,000 for all of it.

The live Rooms' time, minute by minute and Room by Room: 96% of it (9,690 of 10,091 GB-s between 14:40 and 18:30 UTC) lay
in 113 stretches in which a Room was active every second of every minute, for 14 minutes at a time, with no frame in or
out and next to no CPU. 15 to 20 Rooms at once at the worst. A Room awake costs 128 MB for each second, so one such
stretch is about 107 GB-s.

## The cause
One Room's log (Workers observability), the first stretch:

    14:53:09  Alice's socket S1 is let in
    14:57:09  her app comes back on a new socket S2 (its heartbeat gave S1 up); the Room closes S1 as superseded.
              No close of S1 comes back: its connection is dead in the network
    14:57:18  sweep, 8 ms
    14:58:18  sweep, 11 ms
    14:59:18  sweep: from here every alarm lasts 60.000 s, one after the other, and the Room is active throughout
    15:13:16  "socket end {close, 1006, closing, age 1207 s}": Cloudflare reports S1 gone. The Room sleeps again at once

1. A socket whose client the network cut off answers no close. Its connection stays, on Cloudflare's side, until TCP gives
   up, about 16 minutes after the Room's close frame went out. Until then it is in `getWebSockets()`, in stage `closing`.
2. The sweep closed such sockets again at every alarm (`ws.close(CLOSE_SILENT, 'still closing')`, there since
   2026-09-10, e1db898). A second `close()` is meant to do nothing.
3. The runtime forgets that a socket was closed. workerd, `api/web-socket.c++`: a socket woken from hibernation gets
   `closedOutgoing` back from its hibernation package, but not `closedOutgoingForHib`, the copy written into the package
   at the next hibernation. So after the second hibernation since its close the socket counts as open again, and the next
   `close()` queues a second close frame.
4. Nothing reads that frame: the first close has gone through, and what passes frames on has stopped there. The write
   waits until the connection ends. A pending write is work under way, so the Room does not hibernate, and each alarm's
   event lasts until the next one takes over (hence 60.000 s). The Room is billed for all of it.

So: closed at the reconnect, slept twice, closed again by the third sweep, awake until the dead connection ended. 96 of
the 97 stretches of five minutes or more end in the second, or a few after, in which a `closing` socket's 1006 is
logged in that Room. 238 sockets ended that way that afternoon.

A socket never let in went the same way, by another line: the sweep closed an unanswered challenge again at every alarm
too, without marking it, and so did a socket closed for three wrong answers.

## Why that day
One friend's line (Brave on Linux, a cable line in Augsburg) dropped its sockets in bursts from 14:49 UTC on: 14:49 to
14:57, 15:40 to 15:45, 16:27 to 16:51, 17:20 to 18:02 (PostHog, `server_socket_closed`: 449 that day from that browser,
most of them 1006 a ping's length after the last frame). That browser is in 11 rooms, a room of two with each friend
among them (ADR 0011), so each burst left dead sockets in 11 Rooms: about 1,200 GB-s a burst. Earlier days had the same
at a smaller scale and nobody saw it: 1,852 GB-s on 11-12, 1,310 on 11-14.

Why the line dropped is not known. The friends were watching a video together (the watch party, ADR 0012) from about
16:00; the first stretch began at 14:59, and nothing in the party's traffic keeps a Room awake: its changes are a few
small frames.

## Reproduced, 2026-11-16
On the dev box, the Room as built for the browser suite in workerd (`wrangler dev` on `dist/dave`), with a line logged
whenever a Room is constructed, and Node's sockets: Alice through a TCP proxy that stops passing bytes both ways but
keeps both connections open (a client cut off), then Alice again directly, pinging, for 260 s; then the proxy's
connections are destroyed. The alarms' durations are workerd's own (its local traces).

| | before | after |
|---|---|---|
| sweeps while the dead socket is there | 255 ms, 80 ms, then 60,214 ms, 60,391 ms, 11,520 ms (cut short by the connection's end) | 15, 40, 29, 28, 57 ms |
| the Room constructed again at a sweep (it had slept) | at the first two, then not until the connection ended | at every one |

## The fix
The Room closes a socket once, and knows from the socket's attachment that it did, which survives any number of
hibernations: every close goes through `end` (worker/room.ts), which marks the socket `closing` first and leaves one
marked so alone. The sweep passes over `closing` sockets; a close coming in from a socket the Room closed first is not
answered again; an unanswered challenge and a socket closed for wrong answers are marked like the others.

Since nothing closes a socket marked `closing` any more, the mark must never be there without the close: `end` marks,
closes, and only then keeps the socket's TURN users in storage, a write that can fail (the review's finding: before, the
sweep's second close was what closed a socket whose first had been skipped by a failed write).

Tests (test/closeonce.test.ts): the tests' Room never hibernates, so they count the Room's `close()` calls on a socket
whose client does not answer: one, after three more sweeps and after its close came at last. Four ways to be closed. They
fail on the Room from before (4 calls, not 1). A fifth: a socket whose TURN users cannot be kept is closed all the same.

The log of a socket's end (`socket end`, ticket 54) says `let_in` now: a socket never let in is `closing` too once the
Room has closed it, where it was `challenge` before.

## Not verified, and what is left
- On Cloudflare itself: the previews could not run that evening, their Rooms being refused like the live ones. After the
  reset: the same cut-off client against a preview without the fix and against the PR's, read from the analytics.
- Whether frames sent to a socket that is dead but not yet swept (up to 150 s) can fill its connection's buffer and hold
  a Room the same way. Nothing in the logs of that day says so: the stretches begin at sweeps.
- Nothing watches the free plan's use. Had something said "40% of the day's Durable Object time is gone" at 16:45 UTC,
  there were two hours left to act. To build: a check of `/relay-usage` on a schedule that tells the owner.
- The runtime's bug is Cloudflare's to fix; not reported yet.
- The account is on the free plan, whose limits fail hard (ADR 0002). The paid plan ($5 a month) has no daily limit.
