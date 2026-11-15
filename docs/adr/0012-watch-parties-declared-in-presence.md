---
status: accepted
date: 2026-11-15
---

# Watch parties declared in presence, each player YouTube's own

The owner wants to watch YouTube videos with friends (2026-11-14): one friend in the call starts a video of the chat, it
pops up for everyone in the call like a share, with its thumbnail, a click puts them in it, and anyone in it controls
everything (play, pause, seek, speed, another video). Only videos of the chat: a YouTube card (attachments ticket 06) is
the one way in.

Nothing of the video travels between friends: each plays it in YouTube's own embedded player, and only the party's
**state** travels (`src/core/party.ts`): the card's file hash and its video, playing or not, where the video was, at what
speed, when by the Room's clock, and a counter. Each friend in the party **declares** the state as they last took it, as
a `party` field of their presence entry (`{ t: 'party', sealed }`), sealed with the room's text key under the domain
`dave watch party v1` (`sealParty`), as a profile is (ADR 0010): the server lists that a friend is in a party, not what it
plays. The party's state is the latest change anyone declares (`current`: the one made last by the Room's clock, then the
higher counter, then the greater key; a change is never stamped before the one it follows). By time, not by count: a
friend whose socket was gone a while declares the party as it was then, which must not take over one started meanwhile;
a friend who takes a newer change declares it again (client/party.ts), so the party goes on as it was when the friend
who made the last change leaves. Leaving the call, or the socket, ends a friend's declaration with their place in the
call; the party ends when nobody declares one. A state names a card by its file's hash, and a party starts only from a
card of the chat. It carries the card's title too: a friend new to the room since the card was sent does not have it
(they do not see what was said before they came, ADR 0009), and follows the party all the same, its tile showing the
title with no picture, since their browser does not ask YouTube for one before they choose to watch (owner, 2026-11-15).

Where the video is, is said for a moment by the Room's clock, which each app knows as of its last welcome (`roomNow`): a
friend who comes in later, or takes the change later, starts from where it is by then, off by the time the welcome
took to arrive.

The player is driven by the messages YouTube's iframe takes and sends with `enablejsapi=1`, the protocol of YouTube's
iframe API script (`src/client/ytplayer.ts`). The script itself is not loaded: it would run YouTube's code in the page
that holds the rooms' keys. What the friend does in the player is told from what the app asked of it: each request
(a state, a time, a speed) waits for its answer, and anything else the player does is the friend's, a change for
everyone (`syncPlayer`). A player off by more than 1.5 s while playing, or 0.3 s while paused, is put back.

## Consequences

- The Room learns no more than that a friend in the call is in a party, and when they declare a change (a presence
  update each time). It keeps nothing: a declaration lives in the socket's attachment, as `sharing` does.
- Every change goes out once from its maker and once more from each friend in the party who takes it: a few presence
  updates per press for a call of friends.
- The Room's clock as each app has it is off by up to the welcome's trip, so players sit within a few hundred
  milliseconds of each other at best, then within 1.5 s by the drift check. A change is never stamped before the one it
  follows, so one friend's clock ahead (its wall clock moved after the welcome) carries into the changes after theirs:
  the others' players then hold back for as long as it is ahead. The other way round, a friend behind would see their
  changes lose to the one before.
- An ad, should YouTube show one to one friend, holds that player back; the drift check puts it where the party is once
  the ad is over. One friend's seek during an ad is not told apart from the ad's own jumps (not seen yet; YouTube showed
  no ads to the test browsers).
- Esc and keys pressed in YouTube's player stay there, as for the card's own player.
- A party starts paused at its start, and so does another card put on (the owner, 2026-11-15): whoever is in it plays
  it when everyone is there.
- A player that never played, joining a paused party, is played muted to where it is and paused there, then unmuted
  (2026-11-15), as is one given another card, paused: YouTube's way to load a video without playing it (cueing) shows
  its thumbnail, not the frame the others see. A browser that plays nothing by itself, muted or not, gets the thumbnail
  after all (10 s on).
- An app from before this change does not know the field: it shows no party and lists the friends in it as in the call.
  A Room from before (a rollback) refuses `party` as an unrecognised message, which the app ignores: no party starts.
- The browser tests play YouTube's real player: Rick Astley's video is the one YouTube plays to a headless Chromium on
  a datacenter's address (this dev box and GitHub's runners, 2026-11-14); others it asks to sign in, and it refuses
  Firefox there (error 150), so the party's tests run in Chromium only. Some of GitHub's runners YouTube refuses
  outright, from one run to the next (403 to its player's own requests, 2026-11-15): there the tests skip, saying so.
  Should YouTube stop playing it to any of them, they never run; to none of the dev box's, they fail here.

## Considered options

- One state per room kept by the Room (in storage, or a field of its own): simpler to read, but the Room keeps no state of
  its own outside the sockets' attachments (worker/room.ts), and would need clearing when the call empties.
- The state over the call's peer connections: they carry media only (ADR 0001); a data channel would mean renegotiating
  every connection.
- A stand-in player in the tests, as the card's tests use: steady, but it would test the stand-in's idea of YouTube's
  messages. The owner asked for the real player.
