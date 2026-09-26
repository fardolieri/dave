# Spec: decentralized rooms

Decided 2026-09-25 with the owner. Builds on [the P2P friends chat spec](../p2p-friends-chat/spec.md); glossary `CONTEXT.md`; ADRs `docs/adr/`.

## 1. Goal and the claim

The app should prove that a group chat needs no trusted server in the middle. Media already flows peer to peer and ADR 0004 keeps the server out of calls, but text, presence, names, and call control still travel through the Room, and clients trust the server's attribution (ADR 0003).

The claim we want to be able to make when this is done:

> The server is a rendezvous point we do not trust. It cannot read, forge, or reorder your messages, cannot add anyone to your room, and cannot sit in your calls. The worst it can do is refuse to help you connect or withhold stored messages.

What we do **not** claim: that no server exists. Browsers cannot find each other without a rendezvous; swapping ours for trackers or public relays would only move the trust elsewhere.

## 2. Decisions

1. **Every member holds a data link to every other online member**, visitors included (owner, 2026-09-25). Text and control travel over these links, not the server.
2. **Offline delivery via an encrypted mailbox on the Room** (option B, owner, 2026-09-25). Clients also deposit each text, encrypted with a key the server never sees, so friends who were not online at the same time still get it. Peers remain the source of truth; the mailbox is a backup the server can withhold but not read or forge.
3. **Chat history is a grow-only set of signed messages**, merged by union. No CRDT library: plain chat needs none.
4. **Peers verify each other's membership themselves**, with a key derived from the secret that the server never holds. Today the server stores the auth key and could therefore mint a valid login for an invented member.
5. **Order of work**: data links and membership proof, then the text log and mailbox (shipped together), then profiles and call control, then encrypted signaling, telemetry opt-in, and the ADR. A service worker for connection stability is a separate investigation.

## 3. Keys derived from the shared secret

All via the existing `derive(label, secret)` in `src/core/rooms.ts`:

| Label | Name | Who holds it | Used for |
|---|---|---|---|
| `room-id` | Room id | Server, everyone | Socket path, Durable Object name (exists) |
| `auth-key` | Auth key | Server, members | Gate at the server (exists) |
| `member-key` | Member key | Members only | HMAC key for the peer membership proof (§4.2) |
| `mailbox-key` | Mailbox key | Members only | AES-GCM key for mailbox entries (§5.4) |
| `signal-key` | Signal key | Members only | AES-GCM key for signaling payloads (§7) |

The last three never reach the server. Anyone with the invite link holds all of them, which matches the existing trust model: the link is the membership.

## 4. Room links

### 4.1 Shape

- A **room link** is a data-only `RTCPeerConnection` between two members of a room, with one pre-negotiated data channel (`negotiated: true, id: 0`, ordered, reliable). It exists whenever both are online, whether or not either is in the call.
- The call keeps its own media connection per pair, exactly as ADR 0001 describes. Room links do not carry media, so neither connection ever renegotiates to add the other.
- Who offers: the member whose public key compares lower. Perfect negotiation with the existing polite rule handles glare.
- Signaling for room links goes through the server's `signal` message, extended to any two attached members, with a `link: 'room' | 'call'` field. Descriptions are signed per ADR 0004 on both kinds.
- TURN credentials become available to visitors too. Traffic on a room link is tiny, so relay cost is negligible.
- The existing connection transparency applies: every room link shows direct, relayed, connecting, or unreachable.

### 4.2 Membership proof

When the channel opens, before anything else travels on it:

1. Each side sends `{ t: 'hello', nonce }` with 32 random bytes.
2. Each side sends `{ t: 'proof', mac }` where `mac = HMAC-SHA256(memberKey, "dave member v1\n" + roomId + "\n" + myKey + "\n" + theirKey + "\n" + myNonce + "\n" + theirNonce)`.
3. Each side verifies. On failure the link closes, the peer is marked unverified in the UI, and `member_proof_failed` is filed.

ADR 0004 already binds the DTLS tunnel to the identity key, so a proof arriving on the channel comes from the holder of that key. The server knows the auth key but not the member key, so it cannot pass a member it invented.

### 4.3 Control messages on a room link

JSON frames tagged `t`, validated like `parseClientMessage`: `hello`, `proof`, `text`, `have`, `want`, `msgs`, `profile`, `call`, `mute`, `share`, `subscribe`, `signal` (for the call connection, later, §7). Each frame is capped at 16 KB, like the socket. Messages larger than that (a sync batch) are split.

## 5. Text

### 5.1 The message

```
{ v: 1, id, room, author, name, picture?, at, text, sig }
```

- `id`: 16 random bytes, base64url. The de-duplication key (replaces sender plus server timestamp).
- `at`: the author's clock in ms, made monotonic per author (`max(now, last + 1)`).
- `name`, `picture`: the author's profile at send time, as today.
- `sig`: ECDSA P-256 by the author's identity key over `"dave text v1\n" + room + "\n" + id + "\n" + author + "\n" + at + "\n" + name + "\n" + (picture ?? "") + "\n" + text`. Changing this string is a protocol break.

A receiver drops a message whose signature fails, whose `room` is not this room, whose text breaks the existing limits, or whose `at` is more than 10 minutes in its own future.

### 5.2 Order and storage

- Displayed in `(at, id)` order, so everyone sees the same order for the same set.
- Stored per room in IndexedDB, keyed by `id`, capped at the newest 500 by `(at, id)`.
- **Clear history** becomes a watermark: the room remembers the `(at, id)` of the newest message at clearing time and ignores anything at or below it from then on. Otherwise the next sync would bring everything back.

### 5.3 Delivery between peers

- **Live**: the author sends `text` to every verified room link. A receiver that sees an `id` for the first time forwards it once to its other verified links. That covers pairs whose direct link failed.
- **Sync on link open**, after the proof: each side sends `have { ids, horizon }`, where `ids` lists everything held and `horizon` is the oldest `(at, id)` held when at the 500 cap, or null. The other answers `msgs` with what it holds that is missing and newer than the horizon. 500 ids are about 11 KB, split across frames if needed.
- Cues and unread counts only for messages that are new to this browser, not authored here, and arrived live or by sync while the room was open. Sync of old messages on page load does not chime.

### 5.4 Mailbox (option B)

- The Room keeps up to 500 **mailbox entries** per room in Durable Object storage: `{ id, at, blob }`, where `blob = AES-GCM(mailboxKey, iv, signedMessageJson, aad = roomId + id)`, padded to a multiple of 256 bytes before encryption so the length says little.
- Client to server: `{ t: 'deposit', id, at, blob }` after every own text; `{ t: 'fetch', since }` on every (re)connect, `since` being the newest `at` held (minus a 10-minute slack for clock drift). Server replies `{ t: 'mail', entries }`, split under the frame cap.
- The server checks size and rate, stores, and trims to 500. It cannot decrypt, verify, or order meaningfully beyond `at`. A client decrypts, verifies the signature as in §5.1, and merges as if from a peer. Replays are harmless (dedup by `id`); forgeries fail the signature.
- What the server still learns: who deposited when and roughly how big. Accepted.
- Retention: 500 entries per room, and an entry older than 30 days is dropped at the next deposit. Free-tier storage and write limits must be checked when building.

## 6. Profiles and call control

- **Profile**: `{ t: 'profile', name, picture?, at, sig }`, signed like texts with its own label, sent on every link after the proof and again on change. Replaces `name` and `picture` on the socket.
- **Server presence shrinks** to public key and fingerprint per attached socket, plus the participant flag the server still needs to decide who may request TURN credentials (§6, last bullet). The name at auth goes away.
- **Before a room link verifies**, a member shows their fingerprint and the last name known from the local address book, marked as connecting.
- **Call membership, mute, share, subscribe** travel on room links. `join` and `leave` on the socket remain only as far as TURN minting needs them; the server no longer relays `subscribe` or publishes `muted` and `sharing`.
- Honest residue: the server can still infer who is in the call from TURN requests and call-link signaling.

## 7. Encrypted signaling

- `SignalData` payloads (descriptions, candidates, signatures) are sealed with AES-GCM under the signal key, `aad = from + to + link`. The server routes by public key only and no longer sees SDP or ICE candidates, so it no longer learns everyone's IP addresses from signaling. The TURN provider and Cloudflare's edge still see connection IPs.
- Once a room link is up, call-link signaling travels on the room link instead of the socket. The server is then needed only for each pair's first room link.

## 8. Telemetry

PostHog is a third party. Before the claim is made, analytics and masked session replay become **opt-in per browser**, off by default, with a plain explanation in the UI. Problem reports stay available and say clearly that they go to PostHog.

## 9. Rollout

- Each protocol step fails closed, as ADR 0004 did: a tab on the old client cannot talk to a tab on the new one until it reloads. Acceptable for a friends room; note each deploy in the ticket.
- Server `text` relay is removed in the same deploy that adds the mailbox, so offline delivery never regresses.

## 10. Out of scope

- Removing a member without making a new room (would need MLS or similar).
- Discovery without our server (trackers, DHTs, Nostr relays).
- Edits, deletes, reactions. The log format leaves room for them as additional signed records.
- Hash-linked history (each message naming its predecessors), for proof of completeness. A candidate for later.
