# 06 · Bonk: the ball follows the mouse held

Status: in review (the toggle landed 2026-11-22, PR #186; replaced the same day)
Raised by: the owner, 2026-11-22

**Why:** "Maybe we can have a toggle that changes the controls on phones. the alternative control should be that the
ball moves to the position where the finger/cursor is instead of draging from a fixed position. I want to explore if
this feels better. and while we are at it we can add the same for mouse holds and mouse button for dashing." Tried once
before as the only way to steer (PR #179, closed unmerged, 2026-11-21); now beside the stick, to compare.

**What was built:**
- A button at the top right of the game, 🕹️ Stick or 👆 Follow, kept in this browser (`bonkControls`,
  core/storedstate.ts). Stick, the default, is the game as it was: a drag stick on a touch screen, the mouse does nothing.
- Follow: while a finger or the left mouse button is held on the game, the ball rolls toward the spot under it on the
  floe, and on as it moves; a small ring shows the spot. It steers for the speed that gets there and brakes near the
  spot (`toward`, core/bonk.ts), so the ball stops on it instead of sliding past and swinging round it on the ice.
- In Follow, the right mouse button dashes toward where it was pressed (no context menu on the game then); Dash and
  Space dash toward the spot held, if one is. The keys still steer when nothing is held.

**Not done:** tried on no real phone (rung 4 for the owner): which of the two feels better is the question.

**Tried, then changed (2026-11-22):** "Lets remove the new controls from smartphones. The fixed point control is better
there. But on desktop we can allow both controls simultaniously. That removes the toggle on the top right for both
cases." So now:
- No toggle. A finger always drags the stick, as before Follow; Follow is the mouse's alone.
- The mouse steers beside the keys, from the start: the left button held rolls the ball to the spot under it, the
  right button dashes toward where it was pressed. The keys steer whenever the mouse is not held.
- A device with a mouse (`any-pointer: fine`) has Follow's camera: still, a little further back, the fog with it. A phone
  keeps the camera that follows the ball a little.
- `bonkControls` is no longer read or listed (core/storedstate.ts). Browsers that picked a side keep the value, unused.
