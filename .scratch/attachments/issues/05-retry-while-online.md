# 05 · A pull that failed is tried again by itself while its friend is online

Status: in progress
Blocked by: 01
Raised by: the review of PR #68 (Grumpy Friend), 2026-10-16

**Why:** a pull that failed as "unreachable" or "lost" is tried again only when a friend who has the file comes back
online. Two ways it stays failed though the friend is right there:
- The friend's tab was frozen for half a minute (a phone in the pocket): the Room kept her online (silence sweep 90 s),
  the pull found nobody answering, and when she answers again nothing retries.
- A full room: five friends pulling two pictures each ask a slow holder for ten links; she keeps eight, the other two
  asks get no answer and show "Couldn't reach" for good.

**What to build:** while a friend who has the file is online, an "unreachable" or "lost" pull is tried again by itself
with a backoff (5 s, 15 s, 45 s, then on a click), and a holder at her limit answers "busy" instead of nothing, so the
puller waits and asks again rather than failing. The Grumpy Friend's tests for both are in the review of PR #68.
