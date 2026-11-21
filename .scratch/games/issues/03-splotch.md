# 03 · A second game, Splotch; and fullscreen for the games

Status: in review
Raised by: the owner, 2026-11-21 ("Lets add a new game", then "And add a fullscreen button to the games")

**What was built:**
- Splotch: every player a blob of paint on a 24 × 24 board, leaving their colour wherever they go, over anyone else's;
  Space (a button on a touch screen) splats a round patch, every 3.5 s at most. A round plays 45 s; the most of the
  board then wins it. Alone, a friend paints around until a second comes; the countdown clears the board.
- Each app paints its board from what it hears: its own blob's path, every other blob's path between two of its frames,
  and every splat it counts (a counter in the frame, so a lost frame's splat is painted with the next). The leader's
  board counts at the end, and its count goes to everyone with the round (`RoundFrame.sc`).
- The rounds and their leader moved to core/rounds.ts, Bonk's unchanged; what both games draw alike to client/gamekit.ts.
- The call's controls offer both games, one button each.
- ⛶ on a game's tile, while playing: the tile fullscreen, as a share's is, the keys going to the game. Not offered where
  the browser makes no element fullscreen (iPhone Safari).

**Not done:** a real phone (rung 4).
