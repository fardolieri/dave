# 02 · A queue for the watch party: Play next and Add to queue on a YouTube card

Status: in review
Raised by: the owner, 2026-11-17

**Why:** in a watch party, the next video meant someone pressing Watch together on another card, which cut off the one
playing. Friends want to line up what comes next, and have it play when the video ends.

**What was decided** (with the owner, in the conversation of 2026-11-17):
- On a YouTube card of the chat, for a friend in the party only: two icon buttons with tooltips, Play next (first in the
  queue) and Add to queue (last), in place of Watch together, which takes too much room beside them on a narrow card. A
  friend in the call but not in the party sees Watch together, as before.
- Each says ✓ for a moment once it took; nothing goes to the chat. Others see the video come into the list.
- The same card may be queued twice.
- Under the player, for whoever is in the party: up next, each with the face of who queued it, ↑ and ↓ (no dragging),
  and ✕, by anyone in it. Skip in the tile's head plays the next now, playing or paused as the party was; none with
  nothing queued.
- When the video ends, the next goes on and plays, out of the list. With nothing queued, it stays ended, as before.
- 20 videos at most: the buttons say the queue is full past that.
- The queue is part of the party's state, the latest change wins (ADR 0013): two friends queueing in the same moment may
  lose one of the two; they queue it again. It ends with the party.
- A video YouTube refuses to play is not skipped by itself: anyone presses Skip.
- Whoever's player ends first puts the next on; another a moment later may put it back to its start, under a second.

**Found while building it** (each shown in a test):
- The party lives in each friend's socket attachment at the Room, which workerd caps at 16,384 bytes (measured with
  wrangler dev). Twenty entries with whole keys and titles did not fit beside the rest: an entry carries the start of
  its friend's key and up to 90 bytes of the title (ADR 0013).
- Run against YouTube's real player: when Alice's player ended and put the next on, Bob's ended a moment later, after
  his app had taken the next, and put the one after on: one video skipped. An end counts only while the party is near
  its end too (test/partysync.test.ts).

**Changed after it shipped** (owner, 2026-11-17, the day it went live):
- Play now in place of Play next: it stops the video playing and plays the card at once, from its start, at the party's
  speed; the queue stays as it was.
- Text buttons, Play now and Add to queue (Added ✓ for a moment), in place of the icons.
- No Big picture on a YouTube card while in the party: nobody watches a card big meanwhile, and it made room for the
  text. A video file keeps its own.

**Not verified here:** a phone (the list and the buttons were looked at in a 390 px wide Chromium only), Firefox and
Safari with the real player, an ad between two videos.
