# 02: Invite link and identity gate

**What to build:** A friend opens the invite link, the secret is stored and vanishes from the address bar, an identity keypair is created for them, and the app connects. They see their own display name (chosen on first visit) with a six-character fingerprint. Anyone without the secret cannot get a socket attached.

**Blocked by:** 01 Skeleton and deploy pipeline.

**Status:** done (2026-09-06)

- [x] Secret read from the URL fragment on load, stored locally, fragment stripped immediately; later visits use the stored secret.
- [x] ECDSA P-256 keypair generated once with `extractable: false` and kept in IndexedDB; the public key and its six-character fingerprint are shown in the UI.
- [x] Connect handshake: server sends a 32-byte nonce; client replies with HMAC-SHA256 over nonce plus public key, keyed by the secret, and an ECDSA signature over the nonce; server verifies both against its Worker secret before attaching the socket with the identity in the attachment.
- [x] Three wrong answers close the connection; the Worker rate-limits upgrade attempts per IP so failures never wake the Room object.
- [x] Tests cover a correct handshake, a wrong secret, a replayed transcript, and a signature from a different key.
- [x] Display name prompt on first visit, remembered per browser.

## Notes

- 2026-09-06: built on branch `build/02-identity`. The handshake and per-socket state machine live in `src/core` (WebCrypto only) and are exercised end to end inside workerd (19 tests). Per-IP limiting uses the Workers rate-limit binding `UPGRADE_LIMIT` (10 attempts per 60 s), optional in code so local dev and tests run without it.
- Browser check with headless Chromium against the dev server: fresh profile shows "you need an invite link"; opening `/#<secret>` stores it and shows the name prompt; reloading without the fragment keeps working.
- **Deploy prerequisite:** a new Worker secret `ROOM_SECRET` (the shared passphrase) must exist as a GitHub repository secret before the next push; the workflow pushes it to the Worker. The invite link is then `https://dave.danielmittereder.workers.dev/#<passphrase>`. Local dev reads it from `.dev.vars` (copy `.dev.vars.example`).
- Code review (two-axis) findings addressed: malformed base64url no longer throws and every bad pre-auth frame counts as a strike (three-strikes cannot be bypassed); unanswered challenges are closed by a Room alarm after 10 s; the client closes its socket on the first refusal; unknown socket states fail closed; identity load failures are shown; the public key is visible behind a disclosure; "session" renamed to invite/gate per the glossary; auth-message construction shared via `buildAuthMessage`; the 8-character secret minimum removed. The rate-limit binding is emulated in tests and the 429 path is asserted. 24 tests.
- 2026-09-06: deployed and verified live from a Node client using the core handshake code: correct secret gets `welcome` with a fingerprint; wrong secret gets three `authentication failed` errors and close 4001. `ROOM_SECRET` exists as a GitHub secret; the live value is held locally in the gitignored `.dev.vars.live` for build-phase testing and must be rotated before friends are invited.
