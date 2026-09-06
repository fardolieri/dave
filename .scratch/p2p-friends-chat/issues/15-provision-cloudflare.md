# Provision the Cloudflare account, TURN key, and deploy secrets

Type: task
Status: open
Blocked by: none

## Question

Human-in-the-loop task. Nothing to decide, but the spec must record facts, not assumptions, and one fact is still unverified: whether creating a Cloudflare TURN key needs only a card on file or a paid plan. Checklist for the human, with the agent preparing a wizard where it helps:

1. Create or sign into a Cloudflare account. Put a card on file only if asked. Confirm the Workers plan is Free and note the overage behaviour shown.
2. Pick and record the `workers.dev` subdomain name.
3. Create a Realtime TURN key in the dashboard. Record whether it required a plan change, the TURN key ID, and where the key token is stored (Worker secret name, not the value).
4. Create a Cloudflare API token scoped for Workers deploys. Add it and the account ID as GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` on `fardolieri/dave`.
5. Set a zero-spend notification if the dashboard offers one.

Resolve by recording: subdomain name, TURN key ID, secret names, whether the card was required, and whether TURN needed a paid plan. If it did, switch the TURN decision to Metered Open Relay and record the quota the dashboard shows.
