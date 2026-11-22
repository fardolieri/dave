# 05 · Clink, in Splotch's place: a game of chance and nerve, and a check of how fun it is

Status: in review
Raised by: the owner, 2026-11-22 ("Lets remove the splotch game. And replace it with a new fun game. Maybe something a
gambler addict would enjoy. Do some research around incremental games and create the best game you can think of. create
some verification system that lets you verfy the game and how fun it is")

**What was looked at:** incremental games (costs growing faster than what they buy, numbers that grow by orders of
magnitude, prestige; Pecorella's "Math of Idle Games"); the slot machine roguelikes (Luck be a Landlord, Balatro,
CloverPit: rising targets, the agency of what to buy); push-your-luck (keep what you have or risk it for more,
simultaneous decisions made aloud); what keeps a gambler at it (Dixon's work on near misses and wins dressed up with
sound); crash games (a multiplier rising until it falls, the felt skill of when to get out, seeing others get out); and
how games are judged by simulation (Browne's drama and lead changes, agent playtesting's gap between a thoughtful player
and a random one, no one strategy that wins every time).

**What was built:** Clink (core/clink.ts, client/clink.ts). A tower of coins in the middle of the table; everyone's
stake on it (a quarter, half or all of their chips); coin by coin it grows, ×1.2, ×1.5 … ×100 at the top; each coin's
odds of toppling it shown before it lands, more the higher it is, more when it shakes. Grab and the stake comes back
multiplied; ride it down and it is gone. Golden coins pay the pot (grown by every coin landed) to everyone still on.
After a grab, double or nothing on what it won, the stake safe. A shop between climbs: a piggy bank (what you keep off
the tower grows each climb), a lucky charm (grabs win more), a safety net (keep some of a stake that falls), a magnet
(golden coins pay you more). Every climb pays more than the last. Ten climbs to a match; most chips wins. While one
waits alone, climbs go on for practice. Splotch is gone (ticket 03).

**The fun check:** test/fun.ts measures matches; test/clink.fun.test.ts plays thousands of them with bots of several
kinds (random, a novice, timid, reckless, all in, steady, one who never buys, one who buys everything, a smart one who
plays the table) and the game's own rules, and fails if any measure leaves its band. What it found while the game was
tuned, each fixed in the rules, not the bands:
- Staking everything every climb was as good as the best play: the stake choice meant nothing. The piggy bank became
  interest on what you keep back, so holding back has a worth too.
- The loaded coin (better odds on double or nothing) never paid for itself, even for a player who used it well: a trap
  for a new friend. Removed; double or nothing is a plain coin toss.
- The piggy bank and the magnet never paid back their price within a match: repriced until they do.
- Its own bug: two bots that play alike end tied, and ties counted as losses for both. Head to head now counts decided
  matches only.
Where it ended, of 3,000 tables of four and 2,000 duels: the lead changes hands about three times a match; the leader
halfway wins half the time, at four fifths 70%; the winner was last halfway in 11% of matches; the lead changes on the
last climb in 22%; a smart player beats a novice 75% of the time; buying beats never buying, and buying everything
loses; all in is strong (1.3 times its fair share), not the answer; the winner's chips grow some 36 times; a good
moment every 13 s (median); a match about two minutes. `pnpm vitest run test/clink.fun.test.ts` prints all of it.

**Also:** the tower rendered without a GPU (headless Chromium's SwiftShader) ran at 7 frames a second, slowing the page
behind it; such a renderer, or any that turns out slow, now draws plainly (no reflections or shadows, fewer pixels and
frames).

**Not done:** a real phone, and a match played by friends (rung 4). Whether the bands match what people enjoy: the
check says the game is not broken in the ways games are known to be, not that it is fun.
