# Hosting platform, server runtime, and TURN provider decision

Type: grilling
Status: resolved
Blocked by: 03, 04, 07

## Question

Where does the server run, on what runtime, and which TURN provider does it use, at zero cost? The stack decision may rule some hosts out (a Node-only library cannot run on Workers). Decide the platform for the WebSocket hub, the platform for the static SPA (may be the same), the runtime (Node, Bun, or a proprietary edge runtime), the TURN provider and credential scheme, and the domain and TLS story. Record the free-tier limits the spec must respect and what happens when they are hit.

## Answer

Resolved 2026-09-06 by grilling. Recorded as ADR [0002](../../../docs/adr/0002-cloudflare-workers-and-durable-objects-for-the-hub.md).

1. **Card policy** (amended 2026-09-06 after checking Cloudflare docs): a payment card sits on the account. Workers and Durable Objects on Free fail on overage with an error, no charge (confirmed in their pricing docs). TURN is the exception: past 1,000 GB/month it bills $0.05/GB with no hard cap, and budget alerts are informational with a $1 minimum. Accepted because the ceiling is about 900 relayed screenshare hours a month. Mitigations: $1 budget alert, credential revocation on leave, 12-hour TTL.
2. **Hub platform: Cloudflare Workers + Durable Objects (Free plan)**. One Durable Object per Room, using the WebSocket Hibernation API. Oracle Always Free rejected for idle reclamation and ops; Google e2-micro for its 1 GB egress cap; sleeping platforms because presence would go dark.
3. **Runtime**: workerd in production. Toolchain is Node (20.19+ or 22.12+, as the Solid 2 Vite plugin requires) plus wrangler. Tests run inside workerd with `@cloudflare/vitest-pool-workers`. Bun is dropped; the runtime-neutral core from ADR 0001 stands, and the Worker is its one production adapter.
4. **TURN provider: Cloudflare Realtime TURN**, 1,000 GB/month egress metering, `turns:` on 443, credentials minted server-side with `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers` (not the legacy `generate` endpoint) and a TTL of 12 hours; the FAQ caps TTL at 48 hours, the 10-day figure on the "replacing existing" page is a stale example. Free STUN at `stun.cloudflare.com` may be shipped to visitors. Fallback if TURN key creation demands a paid plan: Metered Open Relay, quota to be confirmed in its dashboard.
5. **Static SPA**: served as Worker static assets from the same deployment, never routed through the Worker script, so requests are free and unlimited. The Worker script handles only the WebSocket upgrade and TURN credential minting.
6. **Domain and TLS**: the free `<name>.workers.dev` subdomain to start. A custom domain later requires the zone on Cloudflare and is a config change only.
7. **Free-tier ceiling behaviour**: the spec requires per-socket server-side rate limiting, and a client state "server unavailable, retrying" with backoff. Exposure: 100,000 Durable Object requests per day, incoming WebSocket messages counted 20:1.
8. **Server state rule**: the server holds no state that cannot be rebuilt from attached sockets and their per-socket attachments (16 KB cap). Handed to the presence and text transport ticket as a constraint.
9. **Secrets**: the TURN key API token and access-gating material are Worker secrets, never in the repo or bundle. They are held as GitHub repository secrets and pushed to the Worker by the deploy workflow (`wrangler-action` `secrets` input), so GitHub is the single store. The TURN key ID is not secret and lives in `wrangler.toml`. The repo `fardolieri/dave` is public.
10. **Deploys**: GitHub Actions on push to master, running `wrangler deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets.
11. **Region**: all friends are in one region, so Durable Object placement near the first requester is fine. Nothing to decide.

Consequences for other tickets: presence and text transport inherits the hibernation state rule and rate limiting; the provisioning task (new) closes the card question and records account facts for the spec.
