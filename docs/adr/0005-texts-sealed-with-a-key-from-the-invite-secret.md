---
status: accepted
date: 2026-10-15
---

# Texts sealed with a key derived from the invite secret, and signed by their writer

Texts are to be stored in the cloud later, so that friends who were not online at the same time still get them. Stored
text the server can read is a different promise from relayed text the server can read: it sits there for anyone with access
to the account, a backup or a leak. So texts are encrypted before they leave the writer's browser, now, before anything is
stored. ADR 0003 left text in plain because the server relayed it and was ours; that reasoning does not survive storage.

A text travels as `sealed`: AES-GCM under the room's **text key**, `SHA-256("dave/text-key\n" + secret)`, derived like the
room id and the auth key (ADR 0004) and, like them, never sent anywhere. Inside the encryption the writer signs the room
id, the text's id, their public key and the text with their identity key (ADR 0003's ECDSA P-256 key). The room id and
the id are also the additional data. The plaintext is padded to a multiple of 256 bytes. A friend opens the text, checks
the signature against the identity the server attributed it to, and drops it with a warning if either fails
(`src/core/sealed.ts`).

## Considered options

- A key the server holds (encryption at rest only): protects against a leaked backup, not against the server or anyone
  with access to it. Not the promise wanted.
- Per-friend keys and a group key agreement (Signal's sender keys, MLS): forward secrecy and removal of a member, but key
  distribution needs friends online together or a server that stores key packages, and every new device is a new member.
  Far more code than a friends-only chat needs today. The derived key can be swapped for one later; `sealed` names no
  scheme, but the signed bytes start with a version (`dave text v1`).
- Encryption without signatures: anyone with the link could write a text in another friend's name, and once texts are
  stored the server could too, as long as it had once seen a member's key. One ECDSA signature per text is cheap.
- Keeping plain `text` working for a while after the deploy, for apps cached by the service worker: two paths to test and
  to reason about. The owner chose an error instead: the Room refuses a plain text with "this app is out of date, reload
  the page to send", which the old app shows as "Not sent: …". Old apps do not show sealed texts either until they
  reload; the update bar asks them to.

## Consequences

- Anyone who has the invite link can read every text of the room, past and future, including one stored before they got
  the link. There is no forward secrecy and no way to remove a friend from the key: the secret rotates by making a new room,
  as before (ADR 0004).
- The server still learns who sent a text, when, and its size rounded up to 256 bytes. Its `at` and the sender's name and
  picture are its own tags, unsigned: it can lie about when, and it can replay a text it saw (a friend shows a text of an id
  already seen only once, within the last 1000 and the history). It cannot read a text, change it, move it to another
  room or id, or pass it off as another friend's.
- The Room can no longer check a text's length or emptiness. It caps the sealed size at what the longest text seals to;
  the sending app refuses a longer text itself, and a friend's app drops a text that opens to nothing or too much.
- The local chat history in IndexedDB keeps texts opened, as before: no migration. Names, pictures, presence and call
  control still travel in plain.
- Amends ADR 0003: the server is still trusted to attribute presence and names, but no longer texts.
