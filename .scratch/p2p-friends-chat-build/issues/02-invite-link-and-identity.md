# 02: Invite link and identity gate

**What to build:** A friend opens the invite link, the secret is stored and vanishes from the address bar, an identity keypair is created for them, and the app connects. They see their own display name (chosen on first visit) with a six-character fingerprint. Anyone without the secret cannot get a socket attached.

**Blocked by:** 01 Skeleton and deploy pipeline.

**Status:** in-progress (branch `build/02-identity`)

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
