---
status: accepted
date: 2026-09-10
---

# DTLS fingerprints are signed by the identity key, so the signaling server cannot sit in a call

WebRTC encrypts media with a DTLS certificate each browser generates per connection. Its fingerprint is carried inside the offer and answer, which our server relays. Until now nothing tied that fingerprint to the identity key the server verified at login, so a hostile or compromised Worker could rewrite the fingerprints in both directions and terminate the encryption in the middle while both sidebars kept showing the right identities. Media was encrypted against a passive server only. Now every description a participant sends carries an ECDSA signature by its identity key over the description's `a=fingerprint` lines together with the sender's and the recipient's public keys. The receiver verifies the signature against the public key the server attributed the message to, and drops the description otherwise, before anything is created or torn down. The server passes the signature through untouched and never checks it.

## Considered options

- **Sign nothing, trust the server** (status quo, ADR 0003): acceptable for text attribution, not for the confidentiality claim, because a silent man in the middle is exactly the attack nobody would ever see.
- **Sign the whole SDP**: also binds ICE credentials and codec lines, but those cannot break confidentiality, and any future SDP munging would invalidate signatures. The fingerprints are what DTLS authenticates; signing them is what the W3C identity-provider mechanism does too.
- **Long-lived RTCCertificate pinned per identity**: would let peers pin one certificate, but browsers cap certificate lifetime and a rotating certificate needs a signature anyway.
- **Verify the connected certificate after the fact via `getRemoteCertificates`**: the connection would already be up and media flowing for a moment; refusing the description is earlier and simpler.

## Consequences

- `SignalData` gains `sig`, base64url, only next to a `description`. Candidates are not signed: they carry nothing DTLS authenticates.
- Both sides verify. A description without a valid signature is dropped with a console warning and a `signal_rejected` event; the connection then fails and the stuck-connecting watchdog or the peer's own retry runs as usual. This fails closed by design: a stale tab still running the pre-0004 client cannot join a call until it reloads.
- The trust root is unchanged: peers still learn each other's public keys from the server's presence list and rely on the seen-keys list to notice a substituted key. This ADR guarantees "the tunnel ends at whoever holds identity key X"; that X belongs to the friend you think it does remains trust-on-first-use, to be strengthened separately.
- ADR 0003's statement that the server is trusted for attribution still holds for text and presence. It no longer holds for media: the server can only forward a handshake, not replace it.
- The signing message is `"dave dtls binding v1" \n from \n to \n fingerprints...`, fingerprints normalised (algorithm lowercased, hex uppercased, sorted, de-duplicated). Changing it is a protocol break; bump the version tag.
