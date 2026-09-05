# Multiple simultaneous screen shares in a WebRTC mesh

Type: research
Status: open
Blocked by: none

## Question

How should several participants share screens at once, with each other participant choosing which shares to view, in a WebRTC mesh? Record: getDisplayMedia support and options (surface choice, audio capture, frame rate and resolution constraints) on desktop Chromium, Firefox, and Safari, and on iOS Safari and Android Chrome; whether a viewer can subscribe to and unsubscribe from a share without renegotiating the whole connection (transceiver direction, track replacement); bandwidth implications of N sharers in a mesh of 5 and of 8; and what viewing a share needs on mobile. Answer from MDN, W3C specs, and browser compatibility data. Findings to `docs/research/multistream-screenshare.md`.
