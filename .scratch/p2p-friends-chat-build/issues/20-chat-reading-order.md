# 20 · Chat lines in reading order, bottom anchoring by script

Status: resolved
From the `bug_report` events of 2026-09-20 (text, annoying): "The flex-direction: column-reverse makes it really hard
to select text in the chat." A reversed column puts the newest line first in the DOM, so a drag across lines selects
against the reading order and the selection jumps. Ticket c03bdde had chosen the reversed column so the browser would
keep the newest line in view for free when the share strip halves the log.

## Built
- `styles.css`: `.chat-log` is a normal column, oldest line first. Few lines still sit at the bottom through
  `margin-top: auto` on the first line.
- `App.tsx` `ChatLog`: the log keeps its own distance to the bottom edge (`gap`) and restores it after every size change
  (a `ResizeObserver` on the log, observed once the first lines are in) and after every change of the lines. A reader
  at the newest line stays there; a reader who scrolled up keeps the lines they were reading in place and sees the
  "new messages ↓" pill. A scroll event that arrives under a different client or scroll height than the last
  measurement is the browser clamping after a resize, not the reader, and restores instead of measuring; without
  that, a strip going away while the reader is scrolled up a little lost the position. Browser scroll anchoring
  stays off.
- `scripts/drive.mjs`: `say()` typed into the emoji picker's search field (inside the form, before the message
  input) since ticket 18, so no driver line reached the chat; the child selector fixes it. `SCROLL_CHECK` measures
  the gap from the bottom of a normal column and reads the last `.msg`.

## Verify
- `pnpm typecheck`, `pnpm test`, `pnpm build`.
- `CHROME=/usr/bin/google-chrome UA_OVERRIDE=1 SCROLL_CHECK=1 node scripts/drive.mjs http://localhost:5199 <secret> Alice Bob --join --share`
  against `pnpm dev --port 5199`, 2026-09-20: gap 0 before and after the strip appears, the newest line's bottom edge
  unmoved at 361 px; scrolled up 60 px, a new line makes the gap 108 with the pill shown, the strip going away leaves
  108, the pill click returns to 0; tall viewport with few lines, the last line's edge at 1341 px with and without
  the strip.
