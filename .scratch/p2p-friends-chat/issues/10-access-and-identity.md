# Access gating and stable identity

Type: grilling
Status: resolved
Blocked by: none

## Question

How does the shared secret gate entry, and how does a per-browser keypair give stable, unforgeable names? Decide: how the client proves it holds the secret without sending it in the clear (hash, HMAC challenge, or deriving a room key); how the secret is distributed and rotated; the keypair algorithm and storage (WebCrypto with extractable false in IndexedDB is the working assumption); how a display name is bound to a key and shown to others; what other clients verify (signed presence, signed text); what happens when a friend loses their key by clearing site data or switching browsers; and whether two friends with the same display name are allowed.

## Answer

Resolved 2026-09-06 by grilling. Recorded as ADR [0003](../../../docs/adr/0003-shared-secret-challenge-and-server-attributed-identity.md).

1. **Proof of the shared secret**: HMAC challenge-response. On WebSocket connect the server sends a 32-byte random nonce. The client replies with HMAC-SHA256(secret, nonce || publicKey) and a signature over the nonce by its private key. The server holds the secret as a Worker secret, recomputes the HMAC, verifies the signature against the public key, and only then attaches the socket. The secret never crosses the wire; a transcript cannot be replayed; the proof is bound to the identity.
2. **Distribution and rotation**: an invite link with the secret in the URL fragment, which browsers never send to the server. The client stores it locally on first load and strips it from the address bar. Rotation is manual: change the Worker secret and send a new link. Screensharing a browser with the fragment visible leaks it, hence the immediate strip.
3. **Keypair**: ECDSA P-256 via WebCrypto, private key `extractable: false`, stored as a CryptoKeyPair in IndexedDB. Universal browser support outweighs Ed25519's elegance.
4. **Name binding**: identity is the public key. UI shows the self-declared display name plus a six-character fingerprint derived from the key hash. Each client keeps a local seen-keys list (key, last name used); a never-seen key shows a "new" badge until the user has interacted with it once.
5. **What is verified**: the server verifies secret possession and key possession at connect, then tags every relayed message and presence entry with the sender's public key. Clients trust the tag. No per-message signatures. Trust assumption recorded in the ADR.
6. **Lost key**: no recovery. The friend reappears with the same name and a "new" badge. Export is ruled out by non-extractability; a key-linking flow is out of scope.
7. **Duplicate names**: allowed. The UI warns "someone else is using this name" on join; the fingerprint disambiguates.
8. **Abuse**: the challenge fails closed after three wrong answers and the connection is dropped. The Worker in front of the room object rate-limits upgrade attempts per IP with the platform rate limiter, so failed attempts never wake the room object.

Consequences for other tickets: the UI prototype shows name, fingerprint, and "new" badge in presence; the spec records the server-trusted attribution assumption.
