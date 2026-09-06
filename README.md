# dave

A single-room chat for a few friends: text, voice, and screen share over a peer-to-peer WebRTC mesh, brokered by a small Cloudflare Worker. Spec: `.scratch/p2p-friends-chat/spec.md`. Glossary: `CONTEXT.md`. Decisions: `docs/adr/`.

    pnpm install
    pnpm dev        # SPA with HMR plus the Worker in workerd, one server
    pnpm test       # core isolation check, then vitest inside workerd
    pnpm typecheck
    pnpm build      # dist/client and dist/dave

Deploys run from GitHub Actions on push to master. Secrets live in GitHub repository secrets and are pushed to the Worker by the workflow; nothing secret is in this repo.
