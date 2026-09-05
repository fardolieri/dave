# Solid 2 release-candidate status and fit

Type: research
Status: resolved
Blocked by: none

## Question

What is the current state of Solid 2 (the release candidate)? Record: current version and release cadence, what changed from Solid 1 that affects a client-only SPA (signals, stores, async primitives, router), whether the router and Vite tooling are RC-ready, known breaking issues, and any caveats for a WebRTC-heavy app that holds MediaStream objects in reactive state. Also note how to render a static SPA with no server-side rendering. Answer from the Solid repo, RFCs, docs, and release notes. Findings to `docs/research/solid-2-status.md`.

## Answer

**Solid 2 is at `solid-js@2.0.0-rc.6` (2026-09-02), API frozen but shipping bug fixes weekly. Usable for this SPA if every package is pinned exactly and moved in lockstep. A single-room app needs no router, which removes the least stable link.**

- **Versions and cadence**: rc.0 on 2026-08-12, seven RCs in three weeks. `latest` is still 1.9.15. No stable date announced. Maintainers: "Release Candidate means the API is frozen but not that there won't be bugs."
- **Changes that matter for a client-only SPA**: writes are staged to a microtask (no `batch`, no writes in component bodies or memos); `createEffect(compute, apply)` is split in two; `createResource` and `Suspense` become async memos plus `<Loading>`; store setters take mutable drafts (`produce` and `createMutable` gone); `solid-js/web` moves to `@solidjs/web` with `jsxImportSource: "@solidjs/web"`.
- **Tooling**: `@solidjs/vite-plugin@3.0.0-next.39` (renamed from `vite-plugin-solid`, needs Vite 8 or 9, Node 20.19+ or 22.12+). `@solidjs/router@2.0.0-next.21` rebuilt its navigation engine as recently as 2026-08-31. Every RC bumps peer ranges.
- **Known issues today**: open P1 store bug in rc.6 (#3284, nested derived-store writes disconnect observers); an RC-to-RC hydration regression fixed in rc.5; 188 issues closed since rc.0 against 21 open.
- **MediaStream in reactive state**: `MediaStream` and `MediaStreamTrack` are platform objects, so Solid 2 stores never proxy them (rc.6 `isWrappable` excludes anything not tagged `[object Object]`). They are held raw and tracked by reference. Internal mutations (`addTrack`, `track.enabled`, `ended`) are invisible to Solid and must be mirrored into signals from WebRTC events. `shallow: true` is the only opt-out for store proxying; `markRaw` is internal.
- **Static SPA with no SSR**: `solid({ start: true })` without `ssr` prerenders a shell to `dist/client/index.html` and `render()`s the app. Deployable to any static host. Official `solid-v2/bare` template pins `solid-js ^2.0.0-rc.6`, `@solidjs/vite-plugin ^3.0.0-next.38`, `vite ^8.1.5`.

Consequence for the map: the UI prototype can start on Solid 2 rc.6 using the `solid-v2/bare` template and no router. The spec should state exact pinned versions and a rule that WebRTC object state is mirrored into signals, never read off the objects in JSX.

Findings (with sources): `docs/research/solid-2-status.md` on branch `research/solid-2-status` (commit 2beb338). Read with `git show research/solid-2-status:docs/research/solid-2-status.md`.
