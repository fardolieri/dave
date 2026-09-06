---
status: accepted
date: 2026-09-06
---

# Cloudflare Workers and Durable Objects host the hub, SPA, and TURN

The hub (presence, signaling, ephemeral text relay, TURN credential minting) must stay always-on at zero cost. Only three platforms do that without an expiring trial: Cloudflare Workers with Durable Objects, an Oracle Always Free VM, and a Google e2-micro. We chose Cloudflare, giving up the earlier Node-or-Bun preference for production, because it is the only option with no operations burden, no idle-reclamation rule, TLS and a domain included, static assets served free and unlimited from the same Worker, and a TURN relay (Cloudflare Realtime TURN, 1,000 GB/month) on the same account. A card may sit on the account because Cloudflare's free tier fails on overage rather than billing.

## Considered options

- **Oracle Always Free VM**: real Linux with Node or Bun and self-hosted coturn, but you patch it, run TLS yourself, and Oracle may reclaim an instance idle for seven days, which a five-friend hub will be most weeks.
- **Google e2-micro**: like Oracle but 1 GB/month egress, too small to host the SPA or a relay.
- **Deno Deploy, Render, Koyeb**: free but sleep when idle, so presence goes dark between visits.
- **Metered Open Relay for TURN**: no card, but its own pages disagree on whether the quota is 20 GB or 500 MB, and one relayed screenshare hour is about 0.9 GB. Kept as the documented fallback if Cloudflare TURN turns out to require a paid plan.

## Consequences

- Production runtime is workerd, not Node. The signaling core stays runtime-neutral (ADR 0001) and the Worker is one adapter; tests run inside workerd via Cloudflare's vitest pool. Bun is dropped from the toolchain.
- The room's Durable Object must use the WebSocket Hibernation API to fit the daily duration budget. The server therefore holds no state that cannot be rebuilt from attached sockets and their per-socket attachments (16 KB each).
- Per-socket rate limiting is required so one broken client cannot exhaust the daily request budget and take the room down until reset.
- SPA assets are served directly by the platform, never routed through the Worker script, so they stay free and unlimited.
- The TURN key token and access-gating material live as Worker secrets. The repo is public.
- Deploys run from GitHub Actions on push to master using a Cloudflare API token held as a repository secret.
- The app lives on a `workers.dev` subdomain until a custom domain is wanted; moving is a config change.
