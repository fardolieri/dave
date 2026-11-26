# 07 · Bonk: a photo finish, and wind from who fell off

Status: in review
Raised by: the owner, 2026-11-26

**Why:** "Lets add a tie condition when the last to balls fall almost at the same time." Then, of the ideas offered
(a lava co-op round after a tie, ghosts, replays, bounties): "Lets do the tie with the shared win and let's make fallen
players allow to blow a wind once every 10 seconds. That should be stackable and they should be able to decide the
direction." The lava co-op round is left for later.

**What was built:**
- A tie (`TIE_MS`, core/bonk.ts): once one ball is left, the leader waits half a second before it names the winner. If
  the last one falls too, the last ones share the round: each gets a win, the banner says "📸 Photo finish!" and a line
  over it "You and Bob share the round" (the big banner keeps to one line, too short for names). The leader hears of
  each fall from that ball's own app, a frame and a link later, so who fell first by less than that was as much the
  links' doing as the players'. Before, the last two falling in the same count
  of the leader's went to nobody.
- Wind (`Gust`, core/bonk.ts): a player out of the round they play may blow a wind across the floe right away, then
  every ten seconds. Aimed with the keys, the stick or the mouse held (an arrow over the floe shows which way; until
  then it points across the floe from where they went in, so Blow on a phone does something at once), blown
  with Space, the right button (toward the spot) or the button that dashes on a touch screen, which says Blow while out.
  It pushes every ball on the floe that way for 1.5 s, the mystery ball too, harder than a ball rolls by itself: one
  left standing still is blown off, one steered against it holds. Gusts add up: two at once beat a player steering
  against them. Everyone sees streaks of air go across, the snow drift, and who blew it.
- On the wire: the round frame's `ti` (who tied), a gust frame `w`. Apps from before ignore both: they show a tie as
  "Nobody is left", with the wins as they are, and their balls are not blown.

**Not done:** the strength of a gust (`GUST_ACCEL`, `GUST_MS`) and the tie's half a second are first guesses, tried by
nobody in a real game (rung 4 for the owner).

**Changed 2026-11-27** (the owner: "Instead of an arrow I would like to have a more subtle wind indicator. And it should
follow the mouse on plain move, not just when holding left mouse button. Then we could start the blow on left mouse
click as well"): the arrow is now a few faint streaks of air drifting across the floe the way the wind would go,
fainter while it cannot blow yet. On a desktop the way follows the mouse over the game, no button held, and a left
click blows it toward the spot clicked; the keys still aim it while pressed.
