# Free TURN relay options

Type: research
Status: resolved
Blocked by: none

## Question

Which TURN providers offer a genuinely free tier suitable for occasional voice and screenshare between a handful of friends, and what are the limits? Evaluate at least Cloudflare Calls TURN, Metered.ca Open Relay and its free plan, Twilio, Xirsys, and self-hosted coturn on a free VM. For each: monthly bandwidth cap, whether credentials are static or must be minted short-lived by a server (and the API for that), TLS/443 support for restrictive networks, and whether the free tier requires a card. Answer from provider docs and pricing pages. Findings to `docs/research/free-turn-providers.md`.

## Answer

**Cloudflare Realtime TURN is the only hosted free tier with enough headroom (1,000 GB/month egress). Everything else hosted is 20 GB or less. Self-hosted coturn on Oracle Always Free has no practical ceiling but costs ops.** Pages read 2026-09-05.

- **Cloudflare Realtime TURN**: 1,000 GB/month free, shared with their SFU. Bills only edge-to-client egress. `turns:turn.cloudflare.com:443` available for restrictive networks. Credentials minted server-side via `POST .../generate-ice-servers` with TTL up to 48 h; the TURN key must never reach the client. Docs are silent on whether a card is needed; a community feature request "No-CC TURN free tier" exists, so assume a billing profile is required until sign-up proves otherwise.
- **Metered Open Relay**: advertises 20 GB/month free, TURNS on 443, no card. But Metered's own pricing page lists the free plan as "FREE TRIAL 500 MB". The two pages disagree; the real quota must be confirmed in the dashboard. Credentials via `POST /api/v1/turn/credential?secretKey=…` with `expiryInSeconds`.
- **Xirsys**: 500 MB/month hard cap after trial. Out.
- **Twilio**: no free TURN ($0.40/GB and up), no `turns:` scheme. Out.
- **Self-hosted coturn on Oracle Always Free**: 10 TB/month egress, `--use-auth-secret` gives HMAC-SHA1 time-limited credentials. Card on file, TLS certificate upkeep, idle-reclamation rule.
- **Sizing note**: one relayed screenshare hour can exhaust 500 MB. Relay is only used when direct connectivity fails, so typical usage is a fraction of total call traffic, but a single friend on a symmetric NAT relays everything to and from them.

Consequence for the map: the hosting decision should weigh Cloudflare TURN's card question. If the whole stack lands on Cloudflare, one account covers Workers, static SPA, and TURN. If a VM is chosen instead, coturn on the same VM is the natural pairing.

Findings (with sources): `docs/research/free-turn-providers.md` on branch `research/free-turn-providers` (commit 6ceef65). Read with `git show research/free-turn-providers:docs/research/free-turn-providers.md`.
