# 07: Attention cues and phone layout

**What to build:** With the tab in the background, the title shows how many friends are in the call and a short chime plays when someone joins or leaves. On a phone the page is one scrolling column: presence list in full, shares stacked above the chat, no share button, and the screen stays awake while watching a share.

**Blocked by:** 05 Screen share with subscriptions. Can run alongside 06.

**Status:** in-progress (branch `build/07-cues-and-phone`, under review)

- [x] Title badge such as "(3 in call)" while unfocused; cleared on focus.
- [x] Join and leave chimes, short and quiet, only for others' joins and leaves.
- [x] Phone width: single column, whole page scrolls, presence list never clips, shares stack vertically above the chat, chat still usable.
- [x] Share screen button replaced by a hint where `getDisplayMedia` is undefined.
- [x] Screen Wake Lock held while at least one share is being watched, released otherwise.
- [ ] Manual check on one iOS Safari and one Android Chrome device recorded in the ticket; failures noted, not blocking (best effort).

## Notes

- 2026-09-06: built on branch `build/07-cues-and-phone`. Rules (title text, join/leave diff ignoring yourself, chime notes) live in `src/core/attention.ts` and are unit-tested (56 tests total); `src/client/attention.ts` applies them: title badge on presence and visibility changes, two-note sine chimes synthesised with WebAudio (no asset files; the context unlocks on the first pointer or key event as browsers require), and a screen wake lock held while any share is watched and live, released when the tab hides.
- Phone layout verified with a 390px emulated viewport in headless Chromium (`scripts/drive.mjs --narrow-last --shot=<dir>`): one column, Online then Call with full lists, stacked actions, two share tiles stacked above the chat, input at the bottom, the page scrolling as a whole.
- The Share screen hint for devices without `getDisplayMedia` shipped with ticket 05.
- Last criterion (manual check on iOS Safari and Android Chrome) is the owner's; best effort per spec §7.5.
