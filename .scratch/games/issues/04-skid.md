# 04 · A third game, Skid: a kart race

Status: in review
Raised by: the owner, 2026-11-22 ("Lets add a third game. How about a mario kart clone")

**What was decided:** an original kart racer, not a copy of Mario Kart: its own name, track, items and look (the owner
asked for a clone; the genre is fair, another game's characters, items, tracks and look are not).

**What was built:**
- Three laps of a winding track (core/skid.ts, a smoothed loop), red and white kerbs, grass that slows you, trees and
  rocks, a checkered gantry over the start. Karts in each player's colour (a palette in the race's order, so no two
  look alike), their face as the driver's head, a chase camera, a minimap, lap, place and time.
- Arrows or WASD drive; Space held while steering drifts, and a drift held long enough boosts when let go; boost pads
  on the road; item boxes give a turbo or an oil slick (E, Shift or Enter), which spins whoever drives over it. On a
  touch screen a stick drives forward and steers, pulled back it brakes; Drift and Item buttons.
- Every app drives its own kart and counts its own laps and finish; the leader ends the race once everyone in it has
  finished, or 25 s after the first did (5 minutes at most), and sends the times with its end.
- Found while building it: your own ball, blob or kart wore "A" (for "A friend") as its face in every game; it wears
  your initial or picture now.

**Not done:** a real phone (rung 4). A whole race by hand in a browser test: the unit test drives three laps instead.
