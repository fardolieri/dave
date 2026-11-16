# 84 · No room let anyone in: the day's Durable Object time was used up by Rooms kept awake

Status: fix shipped 2026-11-16 21:08 UTC (cdc03ea, PR #152; its gate status set by hand on the owner's word, the suite
having passed on a local build in CI, run 43954317539, while no preview could run); our own limit and the watch on the
free plan's use in review (PR "The live site closes its rooms itself…")
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
- Nothing watched the free plan's use. Had something said "40% of the day's Durable Object time is gone" at 16:45 UTC,
  there were two hours left to act. Built after: see below.
- The runtime's bug is Cloudflare's to fix, and known there: workerd issue #7595 (2026-10-01) and pull request #8180
  (2026-11-03, the one line that restores the flag), both open, neither saying that it keeps an object awake and billed.
- The account is on the free plan, whose limits fail hard (ADR 0002). The paid plan ($5 a month) has no daily limit.

## After: our own limit, and a watch
The fix could not go the usual way that evening: master takes only a commit whose preview passed the browser suite, and
the previews' Rooms were refused like the live ones. Two things so that it does not come to that again:

- **Our own limit**, 12,000 GB-s of the day's Durable Object time (`OWN_COMPUTE_LIMIT`, wrangler.jsonc; the live site
  only). From there on the Worker takes a socket itself and closes it with 4007 before any Room is asked, until the day
  ends, UTC. The app says "Today's server time is used up: the rooms are back at 01:00" and asks again every five
  minutes instead of every few seconds. The last 1,000 are meant for the previews, not promised to them: the figure
  is Cloudflare's, some minutes behind, kept up to two more in the Worker (half a minute from 80 % on); a socket still
  attached stays, and a Room already awake runs on. At that afternoon's worst pace (683 GB-s in five minutes) 1,000
  last seven minutes. It does not keep dave up longer: it goes dark a little earlier, by its own word, and in all but
  a runaway with the gate to master still working.
- **A watch** (`quota-watch.yml`, every quarter of an hour): at 40 % and 70 % of a daily limit, an issue labelled `quota`
  and a red run, which mails the owner. It asks Cloudflare itself, so it tells with the site down too.

The recording PostHog has of that browser (15:40 to 21:15 UTC) added this: the friend was hardly at the machine (181
active seconds), the sockets died one after the other, 30 to 90 s after each was opened, for minutes at a time, and the
first video of a watch party was loaded at 16:43:53, after two of the bursts. Something on that browser's way to
Cloudflare dropped quiet connections in phases; what, the recording cannot say.
