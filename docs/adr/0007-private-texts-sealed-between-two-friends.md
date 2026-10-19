---
status: accepted
date: 2026-10-19
---

# Private texts, sealed between two friends with a key each browser publishes

A friend wants to write to one other friend in the room without everyone reading along. The room's text key (ADR 0005)
cannot do that: everyone with the invite link has it. And a text the Room only routes to one friend is private from the
other friends only as long as the server routes honestly, so the server must not be able to read it either.

Each browser makes a second keypair next to its identity, an ECDH P-256 **private text key**, non-extractable, in
IndexedDB (`privateTextKey`). Its public half goes to the Room in the auth message, signed by the identity key over
`dave private text key v1`, the identity and the key, and the Room lists it in presence (`privateTexts`). A private text
is sealed like a text (`src/core/sealed.ts`), under the domain `dave private v1`, with the friend it is for in the signed
bytes and the additional data, and under a key only the two browsers can derive: ECDH of the writer's private text key
and the friend's, through HKDF bound to both identities. A friend's key counts only once its signature checks against
their identity. The Room passes `private` on to that one friend and back to its writer, tagged like a text, with the
writer's key, so the friend can open it after the writer left.

In the app it is a text in the room's chat, marked "🔒 to Bob" or "🔒 to you": started from a friend's profile card, or
by clicking the mark of a private text to me, and ended with the composer's ✕, Escape, or another room.

## Considered options

- Sealing with the room's text key and routing to one friend only: no new key, but anyone with the invite link could read
  it if the server passed it on, and the server could. Private only on trust.
- A separate chat per pair of friends, outside the rooms: a second list, second unread counts, second history, and a
  place to meet that is not a room. Far more than "a word to one friend" needs; the room is where friends are.
- An ephemeral key per text (ECIES): forward secrecy for the writer's side only, and only until the friend's key leaks.
  With non-extractable keys that is a lost device, which is the identity lost too. Static keys are simpler, and the
  shared key is derived once per friend.
- Using the identity key for the ECDH too: WebCrypto keeps ECDSA and ECDH keys apart; an identity key cannot derive.

## Consequences

- Only the two friends can read a private text: not the server, not anyone else with the invite link. The server learns
  that one was sent, by whom, to whom, when, and its size rounded up to 256 bytes.
- A friend whose app is from before this change has no private text key: the profile card says their app is out of date.
- Private texts are live, like texts: a friend not in the room cannot get one, and the Room refuses it ("that friend is not
  here"). One written while the socket is away waits, shown as not sent yet, until the Room lets this browser in again
  and lists the friend. A friend the Room still does not list a minute after the first presence that left them out is
  taken for gone, and the text is not sent; nor is one that waited a day. One waiting when the page reloads is kept in
  localStorage as written, like a text (`unsentPrivate`, apart from the room's `unsent`, so an app from before cannot send
  it to the whole room), and sealed again once the Room lists the friend. After a
  reconnect it goes after the room's waiting texts.
- Each browser keeps its private texts opened in its history, marked by `to`. An app from before this change, after a
  rollback, would show one as a text to the room, in that browser only.
- Losing site data means a new private text key with the new identity. No forward secrecy: anyone who gets a browser's
  private text key can open the private texts sealed with it that they also captured on the wire.
