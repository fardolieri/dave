# Room UI prototype: visitor and participant views

Type: prototype
Status: claimed
Blocked by: 05

## Question

What should the single room page look like and how should it behave, from a visitor's first load through joining, sharing, viewing several shares, and leaving? Build a throwaway Solid 2 prototype with mocked presence and mocked shares, no real WebRTC. It should show: the presence panel with participants and the join affordance visible before joining, the text chat usable as a visitor, the layout when zero, one, and three shares are open, and what changes on a narrow mobile viewport. Link the prototype from this ticket; record the layout and behaviour decisions the user confirms.

Requirement from [Presence and ephemeral text transport model](09-presence-and-text-transport.md): the prototype must show per-peer connection state (direct, relayed, reconnecting, unreachable) and the server socket state (connected, reconnecting, unavailable) as first-class UI, not a hidden diagnostic.

Requirement from [Access gating and stable identity](10-access-and-identity.md): presence entries show display name, six-character fingerprint, and a "new" badge for keys not seen before; the join flow warns when the chosen name is already in use.

## Comments

2026-09-06 prototype built, awaiting the owner's reaction.

- Asset: branch `prototype/room-ui`, folder `prototypes/room-ui/`, checked out as a worktree at `../dave-prototype-room-ui`. Solid 2 rc.6 pinned, plain Vite SPA, no router, no WebRTC.
- Run: `pnpm proto:room-ui` from that worktree root, then `http://localhost:3000/?variant=A` (or B, C). Arrow keys switch variants; the white bar flips role, share count, server state, name clash, and a phone-width frame. URL params make any state shareable, e.g. `?variant=C&role=participant&shares=3&open=alice,bob&server=reconnecting`.
- Variants: A Sidebar (Discord-shaped, presence left, stage centre, chat right, tabs on mobile); B Stage (shares fill the page, participant dock, chat drawer, visitor sees a blurred stage behind a join card); C Chat first (messenger with the call as a pinned card, opening a share splits the page).
- Verified headlessly in Chromium: no console errors; all three variants render in both roles, with 0/1/3 shares, with the server banner, and in the phone-width frame.
