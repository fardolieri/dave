# 01 · A first game in the call: Bonk

Status: in review
Raised by: the owner, 2026-11-21

**Why:** "Make a fun little multiplayer game in three-js. Surprise me. I think I want to make some more smaller games in
the future that can be started from within a call in one click."

**What was built** (ADR 0014):
- Bonk: every player a ball with their face on it, on an ice floe in the sea; roll (arrows, WASD, a stick on a touch
  screen), dash (Space, a button), bonk the others in. The floe shrinks while a round plays; the last one on it wins the
  round; the wins stay up while the game goes on. Alone, a friend rolls around until a second comes.
- One click in the call (Play Bonk) starts it for the call; it shows beside the shares for everyone, and a click on its
  tile joins it. Leaving the call leaves the game.
- Who plays travels sealed in presence; the game itself over game links between the players, never through the server.
- Made for more games: a name in core/game.ts, a module like client/bonk.ts, an entry in client/Game.tsx.

**Found while building it:**
- A bonk worked out by each app for its own ball alone was felt by the ball that ran in only: it bounced off at once,
  and the other app saw the two touch, never meet. The app that finds a bonk now gives the other ball its knock
  (`HitFrame`); test/game.test.ts shows the other app sees only a touch, and that the knock gives what its own app
  would. e2e/game.spec.ts rolls Alice into Bob, who has to go into the sea, but stays green without the knock too: there
  the timing decides which app works the bonk out.
- Headless Chromium notes a GPU stall when it composites the WebGL canvas in software; headless Firefox without a GPU
  gives no WebGL 2 at all, and the game is played blind there. Both are expected in the test, with why.

**Not done:** a phone's touch controls were tried in no real phone (rung 4 for the owner); a second game.
