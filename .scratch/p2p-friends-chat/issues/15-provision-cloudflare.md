# Provision the Cloudflare account, TURN key, and deploy secrets

Type: task
Status: open
Blocked by: none

## Question

Human-in-the-loop task. Nothing to decide, but the spec must record facts, not assumptions, and one fact is still unverified: whether creating a Cloudflare TURN key needs only a card on file or a paid plan. Checklist for the human, with the agent preparing a wizard where it helps:

1. Create or sign into a Cloudflare account. Put a card on file only if asked. Confirm the Workers plan is Free and note the overage behaviour shown.
2. Pick and record the `workers.dev` subdomain name.
3. Create a Realtime TURN key in the dashboard. Record whether it required a plan change, the TURN key ID, and where the key token is stored (Worker secret name, not the value).
4. Create a Cloudflare API token from the "Edit Cloudflare Workers" template. Add GitHub repository secrets on `fardolieri/dave`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `TURN_KEY_API_TOKEN` (the TURN key's API token; the deploy workflow pushes it into the Worker as a secret).
5. Set a zero-spend notification if the dashboard offers one.

Resolve by recording: subdomain name, TURN key ID, secret names, whether the card was required, and whether TURN needed a paid plan. If it did, switch the TURN decision to Metered Open Relay and record the quota the dashboard shows.

## Comments

2026-09-06 progress:
- Payment method added to the Cloudflare account. Account confirmed on the Workers Free plan with Realtime enabled (via Cloudflare's dashboard assistant).
- TURN key created without a plan change. Key ID `d3d456166c56302f67957272a1ff9ba5` (not secret; goes in `wrangler.toml` as `TURN_KEY_ID`). API token held by the owner, to be stored only as the GitHub secret `TURN_KEY_API_TOKEN`.
- Still open: `workers.dev` subdomain name; the three GitHub repository secrets; $1 budget alert.
- GitHub repository secrets verified present by name on 2026-09-06: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TURN_KEY_API_TOKEN`.
- $1 budget alert set.
- Subdomain: candidates proposed `dwaves` (preferred), `davewaves`, `dwave`; Worker name `dave` unless the owner prefers `chat`. Awaiting which name was available.
