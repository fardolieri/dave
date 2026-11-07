---
status: accepted
date: 2026-11-05
---

# Private conversations as rooms of two, under keys of their own

Private texts (ADR 0007) went through a room the two friends shared: the browser asked the Room to deliver a sealed text
to one friend, by key. So the server knew who wrote to whom and when, and a text to a friend online in no shared room
could not go at all, nor be kept for them (ADR 0009). The owner wants private conversations to sync like rooms, and
someone reading the server to see no more than a room of two random people (2026-11-05).

Each private conversation is now a **room of two**, a room like any other underneath. Its secret is one only the two
browsers can derive: ECDH between my private text key and the friend's, as they published it signed by their identity
(ADR 0007), through HKDF bound to both identities (`src/core/sealed.ts`, `pairSecret`). Its room id, auth key and text key
come from that secret as any room's come from an invite secret (ADR 0004). Each browser enters it under a key made for
that conversation alone (`pairIdentity:<friendKey>` in IndexedDB), never its identity, and publishes no private text key
there. Being in the room is the proof: nobody else can derive it, so the other key in it is the friend's.

Texts, files, names and history then work as in any room: sealed with the room's text key (ADR 0005, 0006, 0010), kept by
the server for whoever was away and synced on every connect (ADR 0009). A browser makes the room of two with every friend
whose private text key it has seen published in a room of mine, and keeps that key (`pairKeys` in localStorage), so it
connects to the room of two at every start: a friend can write to me while we share no room online, and I get it when I
come. The conversation shows the friend by their own key and fingerprint, not the one they go by there
(`src/client/privates.ts`).

## Consequences

- What the server sees of a conversation: a room with a random id, two keys found in no other room, sealed texts in it.
  It does not learn whose they are from anything it keeps. What it can still tell, watching connections live: the IP
  address and the moment a browser opens its rooms and its rooms of two, which can link them; that a room has two
  members; how much they write. Hiding that would take a network like Tor.
- A browser holds one socket per room and one per friend it has seen a key of, all opened as it starts. The live site's
  limit of upgrades per IP goes from 10 to 60 a minute (`wrangler.jsonc`).
- The Room no longer routes a text to a friend by key: a `private` frame is refused as from an app out of date. Private
  text keys are still published in presence, where friends meet, to derive rooms of two from.
- A new friend's first texts sent while I was away are news when the room of two first syncs, unlike a room joined on
  a new device: such a room counts them unread (`allNews`).
- Saved state: conversations from before stay readable from this browser's history (`private:<friendKey>`), which nothing
  writes to any more; their new texts come after them. Private texts that waited to go (`unsentPrivate`) go through the
  room of two instead, and leave that list. Unread counts of private conversations from before (`unreadPrivate`) are
  not carried over: a badge from before this deploy is gone once.
- Identity is per browser, as before: a friend's new device is a new identity, so a new conversation, with nothing of
  the old one.

## Considered options

- Keeping the routing through shared rooms, and keeping texts by recipient: the server would keep who wrote to whom.
- A room of two entered with each friend's identity key: its id is random, but the same keys are in the friends' other
  rooms, so the server could tell whose room it is.
- A signed introduction of the conversation's key to the friend, inside the room: redundant, as only the two browsers can
  derive the room.
- Connecting to a room of two only once a conversation exists: a friend's first text, written while I was away, would
  wait until we next met in a room.
