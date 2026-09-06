# 01: Skeleton and deploy pipeline

**What to build:** Opening the live app URL shows a page served by the Worker, and that page opens a WebSocket that round-trips a message through the Room's Durable Object. Pushing to master deploys it. From the developer's side: a pinned Solid 2 SPA, a Worker with a Durable Object binding and static assets, tests that run inside workerd, and one command each for dev, test, and deploy.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `pnpm dev` serves the SPA and Worker locally; `pnpm test` runs the suite inside workerd; `pnpm build` produces the static client.
- [ ] Solid 2 rc, `@solidjs/web`, `@solidjs/signals`, `@solidjs/vite-plugin`, and `vite` are pinned to exact versions and the lockfile is committed.
- [ ] Code layout: `src/core` (runtime-neutral signaling and room logic, no Cloudflare imports), `src/worker` (Durable Object and Worker adapter), `src/client` (SPA). A test proves `src/core` imports nothing platform-specific.
- [ ] The Worker serves static assets without routing them through the script, and upgrades `/ws` to a WebSocket handled by the Room Durable Object with the Hibernation API.
- [ ] A GitHub Actions workflow on push to master runs tests then `wrangler deploy`, passing `TURN_KEY_API_TOKEN` as a Worker secret; `TURN_KEY_ID` is a plain variable in `wrangler.toml`.
- [ ] The first deploy succeeds and `https://dave.danielmittereder.workers.dev` responds; the WebSocket echo works end to end from a browser.
