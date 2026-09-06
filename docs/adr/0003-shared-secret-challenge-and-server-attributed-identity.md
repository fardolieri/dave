---
status: accepted
date: 2026-09-06
---

# Shared-secret HMAC challenge and server-attributed identity

Entry to the Room is gated by a single shared secret and names must be stable and unforgeable across sessions, without accounts. On connect the server issues a nonce; the client answers with an HMAC-SHA256 keyed by the secret over the nonce and its public key, and signs the nonce with its private key. The secret therefore never crosses the wire and the proof is bound to the identity. Identity is a non-extractable ECDSA P-256 keypair in IndexedDB. The server tags every relayed message and presence entry with the verified public key, and clients trust that tag: there are no per-message signatures.

## Considered options

- Sending the secret in the first message over TLS: simpler, but the server sees the secret on every connect and a transcript replays.
- Deriving a room key and encrypting all traffic: text is server-relayed by design and media is already encrypted by WebRTC, so this protects nothing extra.
- Per-message client signatures: would stop a compromised server forging attribution, but the server already reads all text in plaintext and is ours; the cost is not worth the marginal gain.
- Ed25519: cleaner, but WebCrypto support is uneven on older mobile browsers; P-256 is universal.
- Exportable keys for recovery: rejected, non-extractable was a deliberate choice.

## Consequences

- The server is trusted for attribution. Recorded here so nobody later mistakes the tag for a cryptographic guarantee.
- Losing site data means a new identity with no recovery. A key-linking flow is out of scope for this effort.
- Display names are self-declared and may collide; the six-character fingerprint and a local seen-keys list with a "new" badge disambiguate.
- The invite link carries the secret in the URL fragment, stored locally and stripped from the address bar on first load.
