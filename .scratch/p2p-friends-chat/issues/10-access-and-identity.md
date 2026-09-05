# Access gating and stable identity

Type: grilling
Status: open
Blocked by: none

## Question

How does the shared secret gate entry, and how does a per-browser keypair give stable, unforgeable names? Decide: how the client proves it holds the secret without sending it in the clear (hash, HMAC challenge, or deriving a room key); how the secret is distributed and rotated; the keypair algorithm and storage (WebCrypto with extractable false in IndexedDB is the working assumption); how a display name is bound to a key and shown to others; what other clients verify (signed presence, signed text); what happens when a friend loses their key by clearing site data or switching browsers; and whether two friends with the same display name are allowed.
