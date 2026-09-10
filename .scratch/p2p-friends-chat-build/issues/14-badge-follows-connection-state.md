# 14 · Connection badge follows the full connection state, not ICE alone

Found 2026-09-10 while verifying ticket 13 on the live server: a tab still running the old client showed "direct" for three newcomers that had refused its unsigned answers. ICE had succeeded from the old tab's side alone (connectivity checks are authenticated with the recipient's own ICE password, which the newcomers knew from their offers), but the DTLS handshake never completed because they never learned its fingerprint. No media flowed, and because the row no longer said "connecting", the stuck-connecting watchdog never fired: the link sat green and silent until a reload.

**Status:** done (2026-09-10), awaiting deploy

## Changes
- `connectionstatechange` now sets direct or relayed; it fires "connected" only once ICE and DTLS are both up. The stuck-connecting timer and attempt counter are cleared there too.
- The ICE handler keeps recovery (disconnected → reconnecting and restart, failed → unreachable and backoff) and resets the restart counter on success, then defers to the connection state for the badge.
- `refreshStats` switches direct/relayed only while the connection state is connected.
- Spec §8.2 amended.

## Consequences
- A connection that finds a path but cannot finish encryption stays "connecting" and is torn down and re-offered by the watchdog like any other stall.
- A stale tab after the ticket 13 deploy now shows "connecting" for every reloaded friend and re-offers periodically until it reloads; that is the truthful picture.

## Verified
- Driver, three browsers with `--join`: badges direct after about 1 s on every browser, audio flowing on every pair, no console warnings.
