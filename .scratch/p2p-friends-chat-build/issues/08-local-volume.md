# 08: Local volume per participant

**What to build:** Next to every other participant in the Call list, a volume control that changes how loud that person is for you only. It applies to their voice and to the audio of their share, nobody else is affected or informed, and the setting is remembered per browser and per identity so a friend who is always too quiet stays adjusted next time.

**Blocked by:** 04 Join a call with voice.

**Status:** done (2026-09-07), awaiting deploy

- [x] A speaker button on each other participant's row reveals a slider from 0 to 200 percent (step 5, double-click resets to 100); 0 silences them locally.
- [x] The slider sets the volume of that participant's voice element and share-audio element immediately, with no signaling.
- [x] Volumes are remembered per browser keyed by the participant's public key and re-applied when they connect again.
- [x] A participant set below 100 percent shows the percentage on their row so the adjustment is visible.
- [x] Verified with the browser driver: moving the slider changes the audio element volume, and it survives a reload.

## Notes

- 2026-09-07: built on branch `build/08-local-volume`. Volume is applied to the participant's voice element and share-audio element; nothing is signalled. Stored per browser as a map of public key to volume (values of 100 percent are dropped from the map). Verified with the driver: slider to 30 percent set both elements to 0.3 and the row read "30%"; after a reload and rejoin the connection came up at 0.3 again. 59 tests.
- 2026-09-07 follow-up: the range grew to 200 percent, which needs a WebAudio gain stage per participant (raw track, kept attached to a muted element as Chrome requires, feeds a GainNode whose output stream plays through the normal, sink-selectable audio element). Speaker selection: the dropdown from device enumeration where the browser lists outputs, plus a "Choose speaker…" button using `selectAudioOutput()` where that picker exists (Firefox 116+); browsers without `setSinkId` get a hint. Driver: slider to 150 percent set both gain nodes to 1.5 and persisted across reload.
