# Free hosting for an always-on WebSocket hub and static SPA

Type: research
Status: resolved
Blocked by: none

## Question

Which hosting platforms will run, at zero cost with no card-required trial expiring, a small always-on WebSocket server (presence, signaling, ephemeral text relay, TURN credential minting) plus static hosting for a Solid SPA? Evaluate at least: Cloudflare Workers with Durable Objects (WebSocket hibernation, free tier limits on requests, duration, and DO storage), Deno Deploy, Render free web services, Koyeb, Fly.io, Railway, Glitch, Vercel and Netlify for the static part, and a free-tier VM (Oracle Cloud Always Free, Google Cloud e2-micro). For each record: free tier limits that matter for a handful of long-lived WebSocket connections, cold sleep behaviour, whether Node or Bun runs natively or the runtime is proprietary, custom domain and TLS, and WebSocket support. Answer from each provider's current pricing and docs pages. Findings to `docs/research/free-hosting-websocket-hub.md`.

## Answer

**Three options run the hub always-on at zero cost with no expiring trial: Cloudflare Workers + Durable Objects, Oracle Cloud Always Free VM, Google Cloud Free Tier e2-micro.** Sources read 2026-09-05.

- **Cloudflare Workers + Durable Objects (Free plan)**: the only one whose docs never mention a card. Runtime is proprietary (workerd, not Node), so Node-only libraries such as Trystero's ws-relay or the PeerJS server will not run; raw WebSocket signaling written against Web APIs will. DO free tier: 100k requests/day, 13,000 GB-s/day. One never-hibernating object costs 10,800 GB-s/day, so it fits, and WebSocket hibernation makes it fit easily. Incoming WS messages billed 20:1, outgoing free. Overage errors out rather than bills. One Worker can serve the SPA (free, unlimited static requests) and the WebSocket on one domain.
- **Oracle Cloud Always Free** and **GCP e2-micro**: real VMs, Node or Bun native, anything runs. Both require a card at sign-up but never charge for free-tier usage. Oracle may reclaim instances idle 7 days (CPU p95 under 20%, network under 20%). You own TLS, updates, and uptime.
- **Scale-to-zero options that do not qualify for an always-on hub**: Deno Deploy (free, no card, but idles out after 5 s to 10 min without traffic and may evict live sockets), Render Free (sleeps after 15 min, ~1 min wake), Koyeb (one free instance, sleeps after 1 h, $29 card hold). They could work with client-side keepalives and tolerance for wake latency, but presence would go dark whenever the hub sleeps.
- **Do not qualify**: Fly.io (trial only), Railway ($1/month credit), Glitch (hosting ended July 2025), Vercel Functions for the hub (300 s max duration on Hobby).
- **Static SPA**: Cloudflare Workers static assets, Netlify Free, Vercel Hobby (non-commercial) all fine.

Consequence for the map: the hosting decision is Cloudflare (proprietary runtime, no card, zero ops, forces raw WebSocket signaling) versus a free VM (Node or Bun as preferred, card on file, you run the box). Combined with the library research, choosing raw WebRTC over our own signaling keeps both hosting doors open; choosing Trystero closes the Cloudflare door.

Findings (with sources): `docs/research/free-hosting-websocket-hub.md` on branch `research/free-hosting-websocket-hub` (commit e1f537f). Read with `git show research/free-hosting-websocket-hub:docs/research/free-hosting-websocket-hub.md`.
