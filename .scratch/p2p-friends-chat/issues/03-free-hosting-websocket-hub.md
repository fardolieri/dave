# Free hosting for an always-on WebSocket hub and static SPA

Type: research
Status: open
Blocked by: none

## Question

Which hosting platforms will run, at zero cost with no card-required trial expiring, a small always-on WebSocket server (presence, signaling, ephemeral text relay, TURN credential minting) plus static hosting for a Solid SPA? Evaluate at least: Cloudflare Workers with Durable Objects (WebSocket hibernation, free tier limits on requests, duration, and DO storage), Deno Deploy, Render free web services, Koyeb, Fly.io, Railway, Glitch, Vercel and Netlify for the static part, and a free-tier VM (Oracle Cloud Always Free, Google Cloud e2-micro). For each record: free tier limits that matter for a handful of long-lived WebSocket connections, cold sleep behaviour, whether Node or Bun runs natively or the runtime is proprietary, custom domain and TLS, and WebSocket support. Answer from each provider's current pricing and docs pages. Findings to `docs/research/free-hosting-websocket-hub.md`.
