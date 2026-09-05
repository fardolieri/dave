# Map: P2P friends chat

Label: wayfinder:map

## Destination

A spec, ready to hand to an implementer, for a single-room web app where up to five friends share text, voice, and screen over peer-to-peer media, brokered by a small server on a free hosting tier, gated by a shared secret, with the running call visible before you join.

## Notes

- Domain: real-time web, WebRTC, small self-hosted group tooling. Glossary lives in `CONTEXT.md` at the repo root; use its terms (Room, Call, Participant, Visitor, Presence, Share, Shared secret, Identity).
- Tracker: local markdown, see `docs/agents/issue-tracker.md`. Tickets live in `issues/` next to this file. Research findings go in `docs/research/<slug>.md`.
- Skills every session should consult: `grilling` and `domain-modeling` for grilling tickets; `research` for research tickets; `prototype` for prototype tickets.
- Standing constraints from charting (2026-09-05):
  - Hosting and relay must cost nothing. "Free tier with limits" is fine; "cheap" is not.
  - Media (voice, shares) must never be decrypted by a server. A TURN relay that forwards encrypted bytes is acceptable.
  - Design for 5 participants in a call, tolerate 8. No SFU.
  - Text chat is ephemeral: live relay only, nothing stored.
  - Stack preference: TypeScript end to end, Solid 2 (release candidate) for the SPA, Node or Bun on the server. Plain WebSocket signaling is acceptable if evidence favours it.
  - Targets: desktop Chromium and Firefox fully. Mobile browsers for voice, text, and viewing shares as a stretch.
- Plan, don't do: this map produces decisions and a spec, not code. The one exception is the prototype ticket, which produces throwaway UI.

## Decisions so far

<!-- one line per resolved ticket: gist, then link to the ticket for detail -->

## Not yet specified

- Reconnection and failure behaviour: what a participant sees when the server restarts, when a peer drops, when their own network flaps. Sharpens once the presence and transport model is decided.
- Share audio: whether a share carries tab or system audio where the browser offers it. Depends on the screenshare research.
- Exact mobile scope: which of voice, text, and viewing shares actually work on iOS Safari and Android Chrome, and what the UI hides there. Depends on the screenshare research and the UI prototype.
- Provisioning: signing up for the chosen hosting platform and TURN provider, generating credentials, wiring short-lived TURN credentials through the server. Becomes a task ticket once hosting and TURN are decided.
- Background notification when a friend starts or joins a call while the tab is unfocused, and whether that is in the spec at all.
- Voice controls: mute, push-to-talk, device selection, noise suppression. Sharpens in the voice and share behaviour ticket, may spill into its own.
- Shape and level of detail of the final spec document, and where it lives in the repo.

## Out of scope

- Multiple rooms or channels. One room exercises the whole hard part; channels are a data-model layer for a later effort.
- Camera video. Not requested; voice and shares only.
- Persistent text history, encrypted or not. Ruled out on 2026-09-05 in favour of ephemeral text.
- Accounts, allowlists, or third-party sign-in. The shared secret is the boundary.
- Visitor visibility with an invisible mode (seeing who is online but not in the call). Deferred to a later effort; noted so a privacy toggle is designed in when it comes.
- Selective forwarding unit or any server that handles media. Contradicts the privacy constraint and the participant ceiling makes it unnecessary.
