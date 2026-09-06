# 04: Join a call with voice

**What to build:** A visitor clicks Join and appears first in the Call list; other participants hear them. Up to eight participants form a mesh with one connection per pair. Each participant sees, per peer, whether the link is direct, relayed, reconnecting, or unreachable. Mute works and shows on everyone's sidebar. Speaking rings light up. Leave tears the connections down.

**Blocked by:** 03 Presence and text for visitors.

**Status:** ready-for-agent

- [ ] Join assigns a join sequence and returns TURN `iceServers` minted server-side from Cloudflare with a 12-hour TTL; credentials revoked on leave; STUN shipped to visitors.
- [ ] Newcomer creates the connection and first offer to each existing participant; the offerer pre-adds the three fixed transceivers (voice audio, share video, share audio); the answerer adopts the created ones, sets them to sendrecv, attaches tracks, then answers. Verified in tests that both sides end with exactly three transceivers and one negotiation round.
- [ ] Perfect negotiation with polite side = lower public key string; a test forces simultaneous offers and asserts both sides converge.
- [ ] Voice track attached via `replaceTrack`; join unmuted with last mute state remembered; mute disables the track and broadcasts the flag; speaking rings from a local analyser on own mic and received tracks.
- [ ] Per-peer stats every 2 s drive the badge: selected candidate pair type gives direct or relayed; ICE disconnected shows reconnecting and restarts ICE after 5 s; failed shows unreachable and retries with backoff; nobody is removed from the call by media failure.
- [ ] Server reconnect keeps peer connections alive and re-declares role, sharing, and muted; a Room alarm every 60 s while any socket is attached drops sockets silent for 90 s (amended from "while a call exists" on 2026-09-06, agreed by the owner, to clear ghost visitors).
- [ ] Leave closes connections on both sides and the server announces it; the Call list shows the user first and others in join order.
