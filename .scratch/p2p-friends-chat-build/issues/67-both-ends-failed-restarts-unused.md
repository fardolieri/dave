# 67 · When ICE fails at both ends of a call, neither ICE restart is used, and the call comes back only by rebuilds

Status: open, found 2026-10-28 by the recovery simulation (ticket 66); not seen in the field or the e2e suite yet
Type: bug (slow recovery, no lost call)

## What the simulation shows
`test/recovery-sim.test.ts`, "a call that was up and loses its path at both ends …". A call is up; the path goes at both
ends at once (a Wi-Fi change under one friend fails ICE for both). Each side restarts ICE after 2 s (F, R8). Each
restart offer reaches a side whose own ICE failed, which O4 answers from a new connection, closing its old one. Both
old connections are gone, each new answerer is paired with the other's closed connection, and both fail; the
connections never connected are then rebuilt (F, R9), and the call is back 10 s after the break, where a restart taken
up in place would bring it back in about 2.5 s. The test marked `it.fails` there says what it should do: come back on
the same connections, with no answer carrying a certificate the other side never saw.

## Why O4 does this
O4 treats "my ICE failed" as "my connection is dead", which ticket 22 needed for a connection that never carried
anything. For one that was up, an ICE restart from the other side is exactly what can bring it back, and the browser
can apply it to a connection whose ICE failed.

## Question for the owner
A row change in spec §8.2: O4 answers from a new connection when my ICE failed only if mine never connected; one that
had connected takes the restart in place (O5), as perfect negotiation settles two restarts crossing. The simulation
can check it first; the e2e suite has the restart tests for the browsers.
