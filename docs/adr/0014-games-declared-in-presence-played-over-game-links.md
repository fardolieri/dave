---
status: accepted
date: 2026-11-21
---

# Games declared in presence, played over game links

The owner wants little multiplayer games friends start from within a call in one click (2026-11-21): this one first,
more later. A game moves many times a second, which the Room must not carry: every frame through it would cost the free
plan's requests (each run of the browser suite costs some 7,000 of them already, ticket 89) and keep the Durable Object
awake. So a game has two halves, as a watch party (ADR 0012) and a file (ADR 0006) have.

**Who plays which game** travels in presence, as a watch party does: each player declares the game they are in
(`src/core/game.ts`: which one, an id chosen by whoever started it, when by the Room's clock), sealed with the room's
text key under the domain `dave game v1` (`sealGame`), as a `game` field of their presence entry (`{ t: 'game', sealed }`).
The server learns that a friend plays, not what; a game it does not know is a field like any other, so a new game needs
no change to the Room. Leaving the call, or the socket, ends the declaration with the friend's place in the call. The
call's game is the one most players declare, then the one started first, then the smaller id, and whoever is in another
moves over: two friends who start one at the same moment end up in the same game, and a friend whose socket was away a
while, back with a game that ended meanwhile, moves over to the one the others started since, instead of pulling them
back into theirs. The game ends when nobody declares it.

**Everything that moves** goes over **game links** (`src/client/gamelinks.ts`): a data-only RTCPeerConnection between
every two players, opened by the one with the smaller key, signaled through the Room as a file link's `link` frames are,
each description's DTLS fingerprints signed by the identity key (ADR 0004). A game link's name is `game-<id>`, which no
file link's (hex) ever is, so the Room and old apps need nothing new; an app answers a game link only for the game it
plays. Its channel is unordered and sends nothing twice: a ball's place a moment old is worth nothing once a newer one is
on its way. Its ICE servers are the file links' (`linkice`), with TURN even while files keep off the relay
(client/relay.ts): a game sends a few kilobytes a second.

**Bonk** (`src/core/bonk.ts`, `src/client/bonk.ts`, three.js) is the first game. Every app moves its own ball and no
other, and sends where it is twenty times a second. A bonk is worked out by the app whose ball runs into the other: it
bounces its own ball off and sends the other ball its knock (`HitFrame`), which that ball's app adds to it. Both apps may
work out the same bonk, from where each sees the other; the first taken counts, and another between the same two is not
taken for a quarter of a second. The rounds are run by a leader, the player who knows the newest round, then the
smallest key: one who just came in leads nobody until the round reaches them, so they cannot start it over. The leader's
frames are ordered by its clock, so a leader who reloads is followed again at once; a player who comes back during a
round watches it, and counts as fallen in it. A player not
heard from for 2.5 s is out of the leader's count (a hidden tab, a link gone), and the floe shrinks to nothing at last,
so every round ends.

three.js is most of 600 kB: it is loaded only once a friend plays (a chunk of its own, `bonk-*.js`), and the service
worker keeps it with the rest of the build, so a tab left open across a deploy still finds the chunk of its own version.

## Consequences

- A friend's app is trusted with its own ball: a changed app could cheat. Friends only, and nothing is at stake.
- A browser without WebGL 2 plays all the same, blind, and the game says so. Headless Firefox without a GPU gives none
  (this dev box, 2026-11-21): the browser suite plays there blind, and draws in Chromium.
- More games add a name to `GAME_NAMES`, a module like client/bonk.ts, and an entry in client/Game.tsx; the declaration,
  the links and the Room stay as they are. An app that does not know a game does not show it.

## Considered options

- Frames through the Room, as signals go: no peer connection to set up, but every frame a request on the free plan, and a
  Durable Object kept awake for as long as anyone plays.
- A data channel on the call's peer connections: they are negotiated once, with fixed transceivers (ADR 0001); a channel
  would mean renegotiating every connection, mid-call, for apps that may not know it.
- One app running the whole game and the others sending only their keys: one place for every bonk, but every friend's
  own ball a round trip late, and the game gone when that friend leaves.
- The game's state in the Room's storage: the Room keeps no state of its own outside the sockets' attachments.
