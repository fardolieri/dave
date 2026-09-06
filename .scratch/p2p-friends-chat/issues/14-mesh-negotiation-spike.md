# Mesh negotiation spike across Firefox and Chromium

Type: prototype
Status: open
Blocked by: none

## Question

Does the stack decided in [Signaling and media stack decision](07-signaling-and-media-stack.md) actually hold up in browsers? Build a throwaway mesh: a minimal WebSocket signaling relay and a bare page (no Solid, no styling) that opens the fixed transceivers (voice audio, share video, share audio) per peer, uses perfect negotiation with the join-sequence polite rule, and exposes buttons for join, leave, start share, stop share, subscribe, unsubscribe. Run five tabs split across Firefox and Chromium and exercise: three joining within a second of each other (glare), one leaving mid-share, two sharing at once with viewers toggling subscriptions, `encodings[0].active` actually stopping upload (check `getStats`), and `replaceTrack(null)` then `replaceTrack(track)` on Firefox. Record what broke, what needed a workaround, and whether the pre-negotiated model survives. Link the prototype from this ticket.
