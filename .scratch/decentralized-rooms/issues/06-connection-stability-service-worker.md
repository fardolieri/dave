# 06 · Can a service worker (or anything else) keep room links alive?

Type: research
Status: open
Blocked by: 01

## Question

With text on room links, a friend whose tab is frozen or closed is simply absent: they only catch up from peers and the mailbox when they come back. The owner asked whether a service worker would make connections more stable. Find out what helps, on desktop Chromium and Firefox and on mobile.

Known constraints to confirm, not assume:

- `RTCPeerConnection` does not exist in service workers or shared workers, and a service worker is terminated shortly after going idle. So a service worker probably cannot hold room links itself.
- What it can plausibly do: cache the app shell for instant reloads; **Web Push** to wake the browser and show "new message in Room X" when the tab is closed (needs a push subscription stored on the Room and the browser vendor's push service; payloads can be encrypted end to end, but it is another party that sees timing); Background Sync to flush the mailbox outbox.
- In the page itself: when Chromium and Firefox freeze or discard background tabs, and whether an open peer connection, a Web Lock, or playing audio exempts a tab; iOS Safari and Android Chrome behaviour for home-screen apps.

## Answer

(to be filled in: what works per browser, what it costs in server state and third parties, and a recommendation for or against a follow-up task)
