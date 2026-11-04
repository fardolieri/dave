---
status: accepted
date: 2026-11-05
---

# Names and pictures sealed for the room, like texts

Texts travel sealed since ADR 0005, but the name and picture a friend shows went to the server in plain: in the auth,
in every rename, in the presence list it sends everyone, and in the tag on every text. The owner wants the server to hold
nothing it can read of what friends say or who they say they are (2026-11-04), before it starts keeping texts
(ADR 0009), whose tags would otherwise keep the names too.

A friend's name and picture travel as a **profile**: JSON of the name and the picture, sealed with the room's text key and signed by the friend's identity key, like a text (`src/core/sealed.ts`,
`sealProfile`), under the domain `dave profile v1` and the id `profile`. The auth carries `profile` in place of `name`
and `picture`; a new name or picture goes as `{ t: 'profile', profile }`, sealed again. The Room keeps the profile in the
socket's presence entry and in the tag of every text, file and private text as it is, and cannot read it: what it lists
of a friend is their key, their fingerprint and the sealed profile (`WireIdentity`, `WirePerson`).

A friend's app opens each profile once, by writer and sealed text (client/room.ts). It shows the name only if the
profile opens with the room's key and was signed by the identity the Room lists it under, and the name and picture are
as the composer makes them: the server can no longer check them, so the app does. One that does not open is dropped
with a warning (`profile rejected`), and the friend shows under the last profile of theirs that opened, or the name in
my address book, or their fingerprint (me: the name I declared). Presence stays synchronous: a friend listed before
their profile is open (a millisecond, the first time) shows under that fallback until it is. The server can still hand
out an older profile of a friend, which shows their old name; it cannot make up a name.

## Consequences

- The server, and anything that reads what it keeps or logs, sees a friend as their key and fingerprint. The key is the
  same in every room, so it can still tell that one friend is in several rooms, and when; not under what name.
- The Room no longer checks names: 1 to 32 characters, one emoji for a picture. A friend's app refuses one that breaks
  that, as it refuses a text that does not open.
- An app from before this change sends its name in plain, which the server is not to learn, and cannot read the profiles
  of the others: it is not let in, with no transition (precedent of ADR 0005, 2026-10-15). Its socket is closed with
  `CLOSE_OUT_OF_DATE` (4006), not refused: such an app takes a refusal for a wrong invite link and stops for good, but
  tries a closed socket again, its waiting texts kept, showing "reconnecting" and after 30 s "unavailable", until the
  update bar a deploy brings within minutes has it reloaded. Each try tells PostHog `server_socket_closed` with code
  4006: a tab left open sends one every 15 to 30 s until it is reloaded.
- A rollback to before this change meets apps that send no name: the Room of then answers their auth "unrecognised
  message". An app takes that answer in the handshake as a Room that cannot read it, not as a wrong invite link: it
  closes the socket (code 1000, with a warning in the console) and tries again, until the update bar brings it the
  version rolled back to. `rollback.yml` stays the way back from a bad deploy; after one, expect `server_socket_closed`
  with code 1000 every 15 to 30 s from every tab not yet reloaded.
- Nothing stored changes shape: browsers keep names opened, as before (`history:<roomId>`, `seenKeys`).
- A profile is sealed per room, with that room's key: friends in another room cannot open it, and the server cannot
  match two rooms' profiles of one friend by their bytes (it matches them by key anyway).

## Considered options

- A time inside the profile, to keep a server from handing out an old one: friends then disagreed on a name after a
  tab took a room over with the profile it had sealed earlier, or a clock stepped back (review, 2026-11-05).
- Names sealed only in what ADR 0009 keeps, plain everywhere else: less to change, but the server would still see every
  name live, whenever its friend is online. The owner chose everywhere (2026-11-04).
- A name per text, inside the sealed text, and none in presence: presence would show keys only until a friend wrote.
- One key per friend instead of per room (the profile sealed to each friend): needs a key exchange the room key already
  gives, for no gain while the name is meant for everyone in the room.
