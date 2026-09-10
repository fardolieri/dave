# 13 · Bind each call's DTLS certificate to the identity key

Requested 2026-09-10 while reviewing what "end to end encrypted" can honestly mean for this app: the server should only make two peers connect, and once connected it must not be able to read or insert itself into anything. Media was already encrypted between browsers, but the offer and answer that carry the DTLS fingerprints pass through the server unauthenticated, so a hostile Worker could swap them and sit in the middle of every call unnoticed.

**Status:** done (2026-09-10), awaiting deploy

## Built
- `src/core/dtls.ts`: `extractDtlsFingerprints`, `dtlsBindingBytes`, `signDescription`, `verifyDescription` (WebCrypto only). `src/core/identity.ts` exports `importPublicKey`, `signBytes`, `verifyBytes` for it.
- Protocol: `SignalData.sig`, base64url, accepted by the server only next to a description and relayed untouched.
- Client: every local description is sent through `sendDescription`, which signs its fingerprints for the one recipient. Incoming descriptions are verified at the top of the signal handler, before any connection is closed or created; a failure logs `description rejected: <verdict>` and files `signal_rejected`.
- ADR 0004 records the decision; spec §1, §2.2 and §3 and the README amended.

## Verified
- `pnpm test`: 74 tests, including sign/verify round trip, swapped fingerprint, wrong recipient, relabelled sender, unsigned, unsignable, malformed key and signature, and the server passing `sig` through while refusing a malformed one.
- Driver, three browsers with `--join`: all badges direct after 1.0 s, audio bytes flowing on every pair, chat intact, no console warnings. Two-browser run: no warnings either.
- Not verified end to end: an actual man in the middle. That needs a tampering relay; the unit tests cover the crypto path.

## Notes
- The trust root (which public key belongs to which friend) is unchanged and still trust-on-first-use via the seen-keys list. Strengthening it is a separate ticket.
- Fails closed: a tab still running the old client after deploy cannot complete a call until it reloads.
