# 11 · One socket per identity, stuck-connecting watchdog

Reported 2026-09-08: connecting to one friend (Brave) often sits in "connecting…" for a long time; a reload fixes it. Screenshot the same evening: that friend listed twice in the Call list with the same fingerprint, both "direct".

## Diagnosis
- Two rows with one fingerprint = two attached server sockets for one identity. The friend's browser reconnected (1006 on their side) while the server had not noticed the old socket die; the ghost lived until the 90 s silence sweep.
- The stall: `participantByKey` on the server took the *first* entry for a key and gave up if it was a visitor. With a ghost visitor listed ahead of the live participant, every offer to the friend was answered with "that participant is not in the call" and dropped. The offerer stayed in "connecting…" (no ICE ever started, so no state event either, which is why PostHog showed nothing). The client's own lookup on incoming offers had the same first-match flaw.
- Direction-independent, lasts until the ghost is swept, and a reload happening around then looked like the cure.
- The friend's browser sends no telemetry (Brave Shields block PostHog), so their side stays invisible.

## Changes
- Server: auth supersedes older sockets of the same key (close 4004). Lookups match the participant entry regardless of order. Superseded sockets' TURN credentials are revoked.
- Client: close 4004 → "open in another tab" banner, stop reconnecting, "Use it here instead" reconnects and supersedes the other tab. If in the call, the stepped-back tab leaves locally.
- Client watchdog: a peer still "connecting" after 15 s (offerer) / 20 s (answerer) reports `peer_connecting_slow` and rebuilds the connection by offering itself; backoff doubles to 60 s. `signal_dropped` reports offers from non-participants.
- Client: a server-lost peer whose ICE fails or stays disconnected is closed immediately instead of restarting ICE into a void.

## Verification
- Worker test: second socket for the same identity → first closes with 4004, presence lists the person once, the survivor joins and receives signals.
- Driver `TABS_CHECK=1`: second tab in the same profile → banner in tab 1, tab 2 live; take-over flips it.
