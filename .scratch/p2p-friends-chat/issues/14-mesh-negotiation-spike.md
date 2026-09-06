# Mesh negotiation spike across Firefox and Chromium

Type: prototype
Status: resolved
Blocked by: none

## Question

Does the stack decided in [Signaling and media stack decision](07-signaling-and-media-stack.md) actually hold up in browsers? Build a throwaway mesh: a minimal WebSocket signaling relay and a bare page (no Solid, no styling) that opens the fixed transceivers (voice audio, share video, share audio) per peer, uses perfect negotiation with the join-sequence polite rule, and exposes buttons for join, leave, start share, stop share, subscribe, unsubscribe. Run five tabs split across Firefox and Chromium and exercise: three joining within a second of each other (glare), one leaving mid-share, two sharing at once with viewers toggling subscriptions, `encodings[0].active` actually stopping upload (check `getStats`), and `replaceTrack(null)` then `replaceTrack(track)` on Firefox. Record what broke, what needed a workaround, and whether the pre-negotiated model survives. Link the prototype from this ticket.

Added from [Voice and share behaviour](12-voice-and-share-behaviour.md): also exercise, on Firefox and Chromium, changing frame rate and resolution of a live display-capture track with `applyConstraints`, switching `degradationPreference` and `maxBitrate` via `setParameters` mid-share, and setting `jitterBufferTarget` on a receiver. Record which of these take effect live and which need a re-capture.
- 2026-09-06 owner ran Firefox as sharer and viewer against Chrome: share, subscribe, applyConstraints at 60 fps / 720p, stop and restart, jitterBufferTarget 150. "Everything went perfectly well and without problems. No errors logged anywhere." Resolved.
