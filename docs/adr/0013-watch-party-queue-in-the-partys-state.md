---
status: accepted
date: 2026-11-17
---

# A watch party's queue is part of its state, cut to fit a socket's attachment

The owner wants friends in a watch party to line up what plays next (2026-11-17, ticket 02 of watch-party): a card's
Play next (Play now since, which leaves the queue alone) and Add to queue, a list anyone in it reorders or takes from, Skip, and the next played when the video ends.

The queue goes in the party's state (`queue` of `Party`, core/party.ts), sealed and declared in presence as the rest of
it is (ADR 0012): every edit is a change like a play or a pause, and the latest change wins. Each entry names a card as
the party does (its file's hash and its video), with an `id` of its own, since a card may be queued twice. When a
friend's player plays the video to its end while the party plays and is near its end too, their app puts the next on
(`ended` of a step, core/partysync.ts; `advance`, client/party.ts), unless the party has gone on since to another
video or queue: whoever's player ends first. Skip does the same, now, playing or paused as the party was. The speed
stays the party's.

A friend's declaration lives in their socket's attachment at the Room, which workerd caps at 16,384 bytes (wrangler dev,
2026-11-17), beside their profile, up to 32 viewers of their share and up to 16 TURN users. Twenty entries with the
adder's whole key and the card's whole title did not fit. An entry carries the first 11 characters of its adder's key,
enough to find their face among the friends in the room, and its title cut to 90 bytes as JSON writes it, with what JSON
writes longer than its UTF-8 left out (`queuedTitle`). The longest sealed party is about 7.5 KB; test/party.test.ts
checks the longest attachment as JSON against the cap with a kilobyte to spare.

## Consequences

- Two friends who edit the queue in the same moment (within a presence round trip) lose one edit: the latest change
  wins, as with every other change of the party. The owner took that over a merge of everyone's own list, whose entries
  would go when their friend left the call (2026-11-17).
- A video played to its end is put on next by every friend whose player ends before the first one's change reaches
  them: the same next, maybe restarted under a second later. Not one friend elected to do it: simpler, and the drift
  check allows 1.5 s anyway (owner, 2026-11-17).
- A player that ends a moment after another's end put the next on does not put the one after on: the party it has is
  at its start then. For a video a few seconds long, that is not told apart from its own end: its end puts nothing on,
  and Skip goes on.
- A player ended at the end of the party's video, more queued since (a video queued after the last had ended, or a
  friend's seek to the very end), puts the next on at its next look, within a second.
- Each edit is a presence update from its maker and from each friend in the party who takes it, as a play is, now up
  to 7.5 KB each instead of 2 KB, to each friend in the room.
- An app from before neither writes nor keeps the queue: when it declares a change again, it declares it without one.
  This app always writes one, empty too; of two copies of the same change it takes one with a queue (`current`), and a
  change of an old app's (no queue) is taken with the queue it had before, so a friend not yet on the new version
  neither empties it by joining nor by pressing play. The old app shows no queue and no queue buttons. Its play, pause
  or seek made in the moment the queue's next went on (before it took that) puts the video before back, with the queue
  as it was after: the next is lost. Only while a friend's tab is not yet on the new version.
- The Room takes a sealed party up to the new length. A Room from before (a rollback) refuses one longer than its own
  bound (about 2 KB, a queue of about three) as an unrecognised message, which the app now leaves unsaid (it said
  "Dropped" in the chat): that friend's declaration stays as it was until the queue is shorter again.
- The queue ends with the party: the Room keeps nothing of a party.
- A friend whose chat does not have a queued card (new to the room since it was sent) sees its cut title, and its full
  title once it plays, if a friend with the card put it on.

## Considered options

- Each friend declares the videos they queued, the queue being everyone's merged: no edit lost, but a friend's videos go
  when they leave the call, and the order of a merge is one more thing to agree on.
- The whole key and title in each entry, with ten entries at most: the owner asked for twenty.
- A queue kept by the Room in storage: the Room keeps no state of a party (ADR 0012), and it would outlive the party.
