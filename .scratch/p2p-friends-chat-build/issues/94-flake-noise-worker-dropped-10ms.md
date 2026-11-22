# 94 · Flake: the noise removal worker dropped 10 ms of the microphone in a 5 s window

Status: open, cause unknown
Type: flake

Seen 2026-11-22, the gate of #190 at 5f50f6e (run 45070532200, `e2e-local`, Chromium shard 2), first try only:
`settings.spec.ts:75` "noise removal keeps time with the microphone, and stops itself only when friends would hear it go
wrong", on `expect(second.load, 'the worker keeps up with the microphone').toMatchObject({ droppedMs: 0 })`: it read
`droppedMs: 10`, one 10 ms frame. The retry passed. The rate check just before it (0.95 to 1.05) passed.

Not #190's change, by its path: `droppedMs` counts gaps in the timestamps of the frames the worker reads from the
microphone's own stream (`voice.worker.ts`, `drops.frame`), transferred to the worker; #190 adds a once-a-second check
on the main thread of whether each friend's voice element is paused, and plays a paused one. In this test none is.

The same test failed before on other steps (2026-10-15 `toBeEnabled`, 2026-11-17 `toHaveCount`), never on this one.

To look at: whether Chromium's fake microphone on a busy runner skips a frame now and then (a gap in its timestamps
the worker did not cause), in which case the test claims more than a runner can hold, or the worker really fell behind.

## Comments
