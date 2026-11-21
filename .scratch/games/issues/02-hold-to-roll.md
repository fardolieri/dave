# 02 · Roll toward where the mouse or a finger is held

Status: in review
Raised by: the owner, 2026-11-21

**Why:** "Lets add click or tap movement as well. The ball should move to the direction of the holding mouse or finger."

**What was built:**
- While the mouse button or a finger is held on the game, the ball rolls toward the spot under it on the floe, and on
  as it moves; let go, it slides on as before. A small ring shows the spot. The keys still steer when nothing is held.
- It steers for the speed that gets there and brakes near the spot (`toward`, core/bonk.ts), so the ball stops on it
  instead of sliding past and swinging round it on the ice.
- On a touch screen this takes the place of the drag stick (01): the finger says where to go, not which way to push.
  The Dash button stays.

**Not done:** tried on no real phone (rung 4 for the owner).
