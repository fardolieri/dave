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
while, back with a game that ended meanwhile, moves over to the one the others started since (unless as many play it),
instead of pulling them back into theirs. The game ends when nobody declares it.

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
  the links and the Room stay as they are. An app that does not know a game does not show it. **Splotch** came second
  (2026-11-21): the rounds and their leader moved to `src/core/rounds.ts`, and what games draw alike to
  `src/client/gamekit.ts`. Every app paints its board from what it hears, so two boards may differ by a tile where two
  blobs crossed at once; the leader's board counts, and its count goes out with the round's end (`RoundFrame.sc`). A
  friend whose app knew only Bonk saw no Splotch, until it updated. **Skid**, a kart race, came third (2026-11-22): each
  app drives its own kart and counts its own laps and finish, which its frames carry; the leader ends the race once
  everyone in it has finished, or a while after the first did, and sends the times with its end. Item boxes are each
  app's own; an oil slick goes out in its dropper's frames, and each app spins its own kart on it. **Clink** took
  Splotch's place (2026-11-22). Its towers are no one app's: the leader picks a seed for each match (and for practice
  while waiting) and sends it with the round, and from the seed and the round's start every app works out every climb
  alike, which coin topples it, which are golden, how each sits, when each lands (`scriptOf`, `climbsTo`). Nothing about
  a tower goes over the wire, so no change of leader, lost frame or hidden tab can stall a tower or take back a coin:
  a first design, the leader landing coins and sending them, lost them in two reviews' worth of ways. The leader runs
  only the rounds, as in Bonk and Skid, and ends a match when its last climb is over; who leads goes by the newest
  round, then the furthest phase of it, and an app back from a gap follows a moment before leading, so a friend who
  missed a match's end does not end it again. Every player's chips, stake and grab are their own app's, sent in their
  frames, a grab judged by the coins that app has seen land; a friend not heard from but whose link is still open (a
  phone put down) stays in the match, counted by the chips they kept off the tower. A friend's app could read the
  coming coins from its own memory: friends only, as above. What one app does at the table is core/clinktable.ts,
  runtime-neutral and tested several at once over a pretend network (test/clinktable.test.ts). Its balance is checked
  by simulation: bots of several kinds play thousands of matches with the game's own rules, and the matches must land
  in bands for skill, drama (Browne's lead changes and comebacks), pacing and growth (`test/fun.ts`,
  `test/clink.fun.test.ts`), a kit the next game can use too. A friend whose app still knows Splotch can start one that
  updated apps do not show, as above. A renderer without a GPU, or one that turns out slow, draws Clink plainly (no
  reflections or shadows, fewer pixels and frames).

## Considered options

- Frames through the Room, as signals go: no peer connection to set up, but every frame a request on the free plan, and a
  Durable Object kept awake for as long as anyone plays.
- A data channel on the call's peer connections: they are negotiated once, with fixed transceivers (ADR 0001); a channel
  would mean renegotiating every connection, mid-call, for apps that may not know it.
- One app running the whole game and the others sending only their keys: one place for every bonk, but every friend's
  own ball a round trip late, and the game gone when that friend leaves.
- The game's state in the Room's storage: the Room keeps no state of its own outside the sockets' attachments.
