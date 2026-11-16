# 82 · Flake: a video went out without its size, and its big view came up 4:3

Status: open; the cause is likely known, not confirmed
Type: flake

Seen 2026-11-16, the preview run of #148 at d3f2405 (run 43887858846, Firefox shard 2), passed on its retry:
`attachment.spec.ts:64` "a video goes big over the page on its button and back, playing on, the same video, the chat
where it was". First sighting; the test is from 2026-11-13 (d6ba9b1). #148 changes only which shard runs which test.

```
Expected: > 640
Received:   560
> 109 |   expect(big.width).toBeGreaterThan(2 * small.width);
```

## What the failed try shows
- Its screenshot: the big view is a box of 560 by 420, 4:3, with the 16:9 picture letterboxed in it. 4:3 is what
  `App.tsx` falls back to when the file came with no width and height (`ratio()`: `w && h ? w / h : 4 / 3`).
- Its trace: after the file was chosen, Alice's click on Send waited 5.2 s. Send waits for the preview, and
  `videoFrame` (`src/client/files.ts`) gives up on a video after 5 s (`setTimeout(fail, 5000)`), then the file goes with
  no preview and no size. The try took 16.6 s, the retry that passed 11.8 s.

So Alice's Firefox did not get a frame of the video within 5 s, and everything after is the app doing what it says for
a video of unknown size. The test's video is recorded with MediaRecorder: such a WebM has no duration in its header and
no cues, `video.duration` is Infinity, and `videoFrame` then seeks to 1 s (`Math.min(1, duration / 10)`), which Firefox
can only do by reading through the file.

## Next
Not confirmed: whether `seeked` came late or never (a standalone page with a MediaRecorder WebM and those few lines of
`videoFrame`, in Firefox, as in the auto memory's recipe for checking one browser API). Then one of:
- the app is wrong: a video with no duration should not be seeked into but taken at its first frame (`loadeddata`), and
  a recorded clip sent by a friend is a real case (a phone's screen recording aside, MediaRecorder is what web apps
  record with);
- or the test's claim is too wide: it could give the big view's shape from the size the file came with.

Until then the row grows in the ledger under this ticket.
