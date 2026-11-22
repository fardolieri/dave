# 06 · Bonk lags on phones

Status: in review
Raised by: the owner, 2026-11-22 ("The Bonk game is laggy on phones. Lets optimize it!")

**What was measured:** Bonk mounted by itself with three friends rolling round the floe, in headless Chromium dressed as
a phone (390 × 844 CSS pixels at 3×, touch, the CPU slowed four times), for 12 s. Before: some 30 ms of script a frame,
12 ms of it the sea alone, whose 6,561 points were moved and given new normals every frame (normals that flat shading
never reads), and the scene drawn at 2× with shadows on every pixel of the sea. After: some 13 ms of script a frame.
Frames a second there say little: SwiftShader draws on the VM's CPU, which a phone's GPU does not.

**What changed** (client/bonk.ts):
- The waves roll in the sea's vertex shader: the same waves, worked out by the GPU, with nothing sent to it each frame.
- The sea takes no shadows; the floe still does, where the balls are.
- A touch screen draws at most 1.5 pixels for a CSS pixel, not 2.
- Lite, as in Clink: no shadows, one pixel for a CSS pixel. A renderer without a GPU starts lite (so do the e2e tests,
  in Chromium); a device whose middle frame of its first 90 takes longer than 25 ms (40 a second) goes lite then. A
  phone that saves its battery by holding the page to 30 frames a second goes lite too.

**Not done:** tried on no real phone (rung 4 for the owner); the frame rate on a 120 Hz phone is not capped.
