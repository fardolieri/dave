# 01 · Watch a YouTube video of the chat together, in step

Status: in review
Raised by: the owner, 2026-11-14

**Why:** friends want to watch a video together in the call, each seeing the same moment, and talk about it.

**What was decided** (with the owner, in the conversation of 2026-11-14):
- Synced players, not a stream: each friend plays the video in YouTube's own player, and only the party's state travels
  (ADR 0012). Full quality for everyone, phones included.
- Everyone in the party controls everything: play, pause, seek, speed, another video.
- Everyone in the call, like with shares. It pops up for everyone like a share, with the thumbnail; a click joins it.
- Only YouTube videos of the chat: there is no other entrypoint, and it keeps things simple.
- Tests with YouTube's real player, not a stand-in (owner): Rick Astley's video, the one YouTube plays to a headless
  browser on a datacenter address. Probed on the dev box and on GitHub's runners (2026-11-14): Chromium plays it, Firefox
  gets error 150, and "Me at the zoo", YouTube's own iframe API example and Big Buck Bunny never start in either. So the
  party's tests run in Chromium only.

**Found while building it** (each shown in the e2e test or a run of it, with the real player):
- A player that never played starts playing on a seek: a friend joining a paused party set it playing for everyone.
  A paused party's new player is cued where it is instead, and a play while a pause was asked gets the pause again.
- A cued player says it is at the start until it plays: it was cued again every few seconds.
- What the app asked of the player and what the friend did in it were first told apart by a time window after each
  request; a pause pressed in one was lost, and the app's own drift correction came back as a seek for everyone. Each
  request now waits for its answer instead, read off the same report it answers.
- YouTube's embed has touch controls: a press on them hidden only shows them (the tests hover first). On GitHub's runner
  the seek bar's first click still met them hidden, twice (the preview run of 9f8c40a): the test clicks again until
  the video has gone there, as a person would.
- Then, on the runner, the friend's seek was lost again: a slow runner's player is put right often, and a seek the
  friend made while the app's own was under way was taken for the app's. Logged on a runner (a debug branch, the test
  four times): Alice's seek to 85 s came while her app's seek to 2 s was under way. A jump to where the app asked, or
  back to where the player was then, is the app's; one anywhere else is the friend's. And a player that says it is
  unstarted for a moment, as YouTube does while a far seek waits for the network, no longer counts as not started.
- One of those four runners YouTube refused outright (403 to its player's requests, Alice's and Bob's): the tests skip
  there, saying so, as it is not the app that failed.
- Review, before the first push: the latest change was first the highest count, so a friend back after a dropped
  socket made an old party take over one started meanwhile (now by the Room's clock first, and a change's time is part
  of what makes it the same change); a custom speed (YouTube's embed has 0.05 steps) was refused by the others; a seek
  the app asked for was held for 4 s while playing, swallowing the friend's own; a cued player's first play could send
  its start for a moment.

**Not verified here:** an ad (YouTube showed none to the test browsers), a phone, Firefox and Safari with the real player.
