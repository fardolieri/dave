# 01: Skeleton and deploy pipeline

**What to build:** Opening the live app URL shows a page served by the Worker, and that page opens a WebSocket that round-trips a message through the Room's Durable Object. Pushing to master deploys it. From the developer's side: a pinned Solid 2 SPA, a Worker with a Durable Object binding and static assets, tests that run inside workerd, and one command each for dev, test, and deploy.

**Blocked by:** None (can start immediately).

**Status:** done (2026-09-06)

- [x] `pnpm dev` serves the SPA and Worker locally; `pnpm test` runs the suite inside workerd; `pnpm build` produces the static client.
- [x] Solid 2 rc, `@solidjs/web`, `@solidjs/signals`, `@solidjs/vite-plugin`, and `vite` are pinned to exact versions and the lockfile is committed.
- [x] Code layout: `src/core` (runtime-neutral signaling and room logic, no Cloudflare imports), `src/worker` (Durable Object and Worker adapter), `src/client` (SPA). A test proves `src/core` imports nothing platform-specific.
- [x] The Worker serves static assets without routing them through the script, and upgrades `/ws` to a WebSocket handled by the Room Durable Object with the Hibernation API.
- [x] A GitHub Actions workflow on push to master runs tests then `wrangler deploy`, passing `TURN_KEY_API_TOKEN` as a Worker secret; `TURN_KEY_ID` is a plain variable in `wrangler.jsonc`.
- [x] The first deploy succeeds and `https://dave.danielmittereder.workers.dev` responds; the WebSocket echo works end to end from a browser.

## Notes

- 2026-09-06: built on branch `build/01-skeleton`, commit 9e19e13. Cloudflare's Vite plugin runs SPA and Worker in one dev server (note: it binds `localhost`, which resolves to IPv6 first on this machine, so use `localhost` not `127.0.0.1`). Tests use `@cloudflare/vitest-plugin` (the pool package is superseded) with Vitest 4.1. `vite build` writes `.wrangler/deploy/config.json` so plain `wrangler deploy` picks up `dist/dave/wrangler.json`. Hibernation `webSocketClose` must not pass code 1005 back into `close()`.
- The last criterion needs a merge to master and a push; the workflow does the rest.
- 2026-09-06: first deploy green from GitHub Actions. Verified live: `/` 200, `/ws` upgrade echoes, `/ws` without upgrade 426. Unknown paths return 404 from the Worker rather than the SPA shell (a Worker script takes unmatched requests); acceptable since the app has no client routes.
