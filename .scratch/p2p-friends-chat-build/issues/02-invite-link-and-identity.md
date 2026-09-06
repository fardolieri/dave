# 02: Invite link and identity gate

**What to build:** A friend opens the invite link, the secret is stored and vanishes from the address bar, an identity keypair is created for them, and the app connects. They see their own display name (chosen on first visit) with a six-character fingerprint. Anyone without the secret cannot get a socket attached.

**Blocked by:** 01 Skeleton and deploy pipeline.

**Status:** ready-for-agent

- [ ] Secret read from the URL fragment on load, stored locally, fragment stripped immediately; later visits use the stored secret.
- [ ] ECDSA P-256 keypair generated once with `extractable: false` and kept in IndexedDB; the public key and its six-character fingerprint are shown in the UI.
- [ ] Connect handshake: server sends a 32-byte nonce; client replies with HMAC-SHA256 over nonce plus public key, keyed by the secret, and an ECDSA signature over the nonce; server verifies both against its Worker secret before attaching the socket with the identity in the attachment.
- [ ] Three wrong answers close the connection; the Worker rate-limits upgrade attempts per IP so failures never wake the Room object.
- [ ] Tests cover a correct handshake, a wrong secret, a replayed transcript, and a signature from a different key.
- [ ] Display name prompt on first visit, remembered per browser.
