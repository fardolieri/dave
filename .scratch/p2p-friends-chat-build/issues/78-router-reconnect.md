# 78 · After a router reconnect, dave could not reconnect

Status: shipped 2026-11-10 in three parts: the call's socket (a37873d, PR #135), the second restart (c048925, PR #118),
the tab's other sockets (in review)
Type: bug (reported by the owner, 2026-10-30: "I reconnected my internet connection in my router settings but I cannot
reconnect here. I have to restart the tab")

## The report
The owner's FRITZ!Box 7490 reconnects to the internet ("Neu verbinden" under Internet > Online-Monitor). The line drops
for about 6 s and comes back with a new public IPv4 address and a new IPv6 prefix (Telekom). The report, 50 s after the
router's reconnect, shows the server `connected` and the one friend in the call `unreachable`: connection `failed`,
signaling `have-local-offer`, one ICE restart. The night shift's reading of it is in PR #118.

## Reproduced, 2026-11-10
On the dev box behind that router: PR #135's preview open in two tabs, both in its call, the owner's phone on mobile data
in the call too, then "Neu verbinden" clicked twice. A timeline of each page and of the box's addresses was kept.

- Every server socket of both tabs went silent without a close: no close event, no `offline` event (the box's link to
  the router stayed up), and the old temporary IPv6 address was removed. The heartbeat gave the sockets up 60, 87, 84
  and 87 s after the line went, and each came back within a second after that. Nothing showed meanwhile.
- The call between the two tabs never broke (their path stays inside the home network). The phone's went
  `disconnected` for 4 s and came back by itself, without a restart: not the report's failure.

So a restart's offer sent in that minute goes into a dead socket. The report's call restarted ICE about 15 s after the
line went and was still waiting for the answer when the owner reloaded, before the heartbeat would have told.

## The fix (PR #135)
The call's room socket is probed when something says the network changed under it: a ping at once, and the socket given
up if no frame comes within 5 s (`core/heartbeat.ts`, `probe`). Asked when a connection of the call turns `disconnected`
or `failed`, and again at each ICE restart, before the restart's offer goes out. The reconnect then rebuilds the
connections that died, or sends a waiting offer again (`redeclareAfterReconnect`, `resendOffer('own_reconnect')`).
While a file's pieces are going out or wait for the Room's word, the probe waits instead of judging: on a slow uplink its
ping sits behind them (review, two models independently). Regression test: `e2e/resilience.spec.ts`, "an ICE restart asks
the server socket whether it still answers …".

Not covered then: the tab's other sockets (other rooms, rooms of two) and a tab not in a call still waited for the
heartbeat (the third part, below); a socket dead while files wait still does. The e2e test goes through the restart's path with the media path up (the offer sent
again), not the field's (the connection rebuilt), and nothing tests the probe at an ICE state change.

## The second half (PR #118)
A restart while an earlier offer still waited for its answer made no offer (`pc.restartIce()` holds it until stable),
so a second restart did nothing. Now `restartIce` takes the waiting offer back (a rollback) and the restart offers afresh;
a late answer to the old one carries its number and is dropped. Regression test (the night shift's): "an ICE restart
whose offer went unanswered does not hold back the next one …".

## The third part: the tab's other sockets
A socket given up for its silence (heartbeat 4009, probe 4010) has the tab probe all its other sockets at once, and so
does the browser's `online` event: the room of two with each friend and other rooms follow within 5 s, where they waited
60 to 90 s for their own heartbeat (seen on the router, 2026-11-10: 73 s). A tab not in a call gains too, once any of
its sockets' heartbeat tells. Regression test: "a socket found silent has the tab ask its other sockets too …".
