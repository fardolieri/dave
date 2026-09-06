# Room UI prototype: visitor and participant views

Type: prototype
Status: open
Blocked by: 05

## Question

What should the single room page look like and how should it behave, from a visitor's first load through joining, sharing, viewing several shares, and leaving? Build a throwaway Solid 2 prototype with mocked presence and mocked shares, no real WebRTC. It should show: the presence panel with participants and the join affordance visible before joining, the text chat usable as a visitor, the layout when zero, one, and three shares are open, and what changes on a narrow mobile viewport. Link the prototype from this ticket; record the layout and behaviour decisions the user confirms.

Requirement from [Presence and ephemeral text transport model](09-presence-and-text-transport.md): the prototype must show per-peer connection state (direct, relayed, reconnecting, unreachable) and the server socket state (connected, reconnecting, unavailable) as first-class UI, not a hidden diagnostic.
