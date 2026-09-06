# 07: Attention cues and phone layout

**What to build:** With the tab in the background, the title shows how many friends are in the call and a short chime plays when someone joins or leaves. On a phone the page is one scrolling column: presence list in full, shares stacked above the chat, no share button, and the screen stays awake while watching a share.

**Blocked by:** 05 Screen share with subscriptions. Can run alongside 06.

**Status:** ready-for-agent

- [ ] Title badge such as "(3 in call)" while unfocused; cleared on focus.
- [ ] Join and leave chimes, short and quiet, only for others' joins and leaves.
- [ ] Phone width: single column, whole page scrolls, presence list never clips, shares stack vertically above the chat, chat still usable.
- [ ] Share screen button replaced by a hint where `getDisplayMedia` is undefined.
- [ ] Screen Wake Lock held while at least one share is being watched, released otherwise.
- [ ] Manual check on one iOS Safari and one Android Chrome device recorded in the ticket; failures noted, not blocking (best effort).
