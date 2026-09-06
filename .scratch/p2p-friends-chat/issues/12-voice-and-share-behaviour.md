# Voice and share behaviour

Type: grilling
Status: open
Blocked by: 06, 07, 11

## Question

Pin down the user-facing behaviour of voice and shares. Decide: mute and unmute, push-to-talk or voice activity, input and output device selection, noise suppression and echo cancellation settings, speaking indicators; how a participant starts and stops a share and whether share audio is captured; how a viewer opens and closes a share and whether they can view several at once; caps on concurrent shares given the mesh bandwidth research; and what is hidden or disabled on mobile.

Requirement from [Presence and ephemeral text transport model](09-presence-and-text-transport.md): decide how per-peer connection state is derived (selected candidate pair type from getStats, ICE connection state) and how often it is refreshed, so the UI can show direct versus relayed and unreachable honestly. Speaking indicators are computed locally from received audio, never sent over the socket.

Layout settled in [Room UI prototype: visitor and participant views](11-room-ui-prototype.md): shares render as one side-by-side row above the chat, sidebar actions are Mute, Share screen, Leave. This ticket decides the share-row sizing rules, any cap on shares watched at once, what a tile shows while subscribing, and the Mute and Share button semantics.
