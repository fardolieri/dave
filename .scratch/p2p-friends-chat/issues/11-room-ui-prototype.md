# Room UI prototype: visitor and participant views

Type: prototype
Status: resolved
Blocked by: 05

## Question

What should the single room page look like and how should it behave, from a visitor's first load through joining, sharing, viewing several shares, and leaving? Build a throwaway Solid 2 prototype with mocked presence and mocked shares, no real WebRTC. It should show: the presence panel with participants and the join affordance visible before joining, the text chat usable as a visitor, the layout when zero, one, and three shares are open, and what changes on a narrow mobile viewport. Link the prototype from this ticket; record the layout and behaviour decisions the user confirms.

Requirement from [Presence and ephemeral text transport model](09-presence-and-text-transport.md): the prototype must show per-peer connection state (direct, relayed, reconnecting, unreachable) and the server socket state (connected, reconnecting, unavailable) as first-class UI, not a hidden diagnostic.

Requirement from [Access gating and stable identity](10-access-and-identity.md): presence entries show display name, six-character fingerprint, and a "new" badge for keys not seen before; the join flow warns when the chosen name is already in use.

## Answer

Resolved 2026-09-06. The owner reviewed variants A (Sidebar), B (Stage), C (Chat first), chose A and revised it into variant D, which is the confirmed layout.

**Asset**: branch `prototype/room-ui`, folder `prototypes/room-ui/`, variant D is the default (`?variant=D`). Read with `git show prototype/room-ui:prototypes/room-ui/src/VariantD.tsx`. Throwaway; not to be promoted as is.

**Layout decisions**

1. Two columns on desktop: a fixed-width presence sidebar on the left, one main column on the right. No third column.
2. Sidebar order: **Online** (visitors) first, **Call** (participants) below it. Each entry shows avatar initial, display name, six-character fingerprint, "new" badge for unseen keys, and for participants the muted and sharing flags plus the connection badge (direct, via relay, reconnecting, unreachable) when I am in the call.
3. Sidebar actions sit under the Call list, each on its own row, full width: **Join** for a visitor; **Mute**, **Share screen**, **Leave** for a participant. The Share screen button is replaced by a "not available on this device" hint where `getDisplayMedia` is missing.
4. Main column: **chat fills it entirely while nobody is sharing**. This is the default state and it must not look like an empty video stage.
5. When at least one share exists the main column splits horizontally: shares on top, side by side in one row, chat below. Shares take roughly the upper half.
6. Share tiles show the sharer's name and connection badge in a header. A visitor sees tiles marked "join to watch". A participant sees "click to watch" until they subscribe, then the live view with a bitrate and direct or relayed caption. An unreachable sharer's tile is dimmed and says there is no connection.
7. Chat is always visible, never a drawer. The input is disabled with a reason while the server socket is down, and a line notes possibly missed messages after a reconnect.
8. Server socket state is a full-width banner above everything when not connected: reconnecting, or unavailable with retry.
9. Name clash shows a warning under the sidebar actions naming the user's own fingerprint.
10. **Phone width**: one column, the whole page scrolls. The presence list has no max height and never clips. Shares stack vertically above the chat. No tabs.

**Rejected**: B's blurred stage with a join card, and any layout that hides chat behind a toggle; C's pinned call card was liked less than a real sidebar.

Consequences: the voice and share behaviour ticket inherits this layout and decides the share-row sizing rules, caps on shares watched at once, and what the tile shows while subscribing. Mobile layout is settled; what remains for mobile is reliability of voice and viewing on iOS Safari and Android Chrome.

## Comments

2026-09-06 prototype built, awaiting the owner's reaction.

- Asset: branch `prototype/room-ui`, folder `prototypes/room-ui/`, checked out as a worktree at `../dave-prototype-room-ui`. Solid 2 rc.6 pinned, plain Vite SPA, no router, no WebRTC.
- Run: `pnpm proto:room-ui` from that worktree root, then `http://localhost:3000/?variant=A` (or B, C). Arrow keys switch variants; the white bar flips role, share count, server state, name clash, and a phone-width frame. URL params make any state shareable, e.g. `?variant=C&role=participant&shares=3&open=alice,bob&server=reconnecting`.
- Variants: A Sidebar (Discord-shaped, presence left, stage centre, chat right, tabs on mobile); B Stage (shares fill the page, participant dock, chat drawer, visitor sees a blurred stage behind a join card); C Chat first (messenger with the call as a pinned card, opening a share splits the page).
- Verified headlessly in Chromium: no console errors; all three variants render in both roles, with 0/1/3 shares, with the server banner, and in the phone-width frame.
- 2026-09-06 owner picked A, revised into D (Online above Call, chat centre, shares split in above chat, stacked full-width sidebar buttons, scrolling phone layout). Confirmed. Resolved.
