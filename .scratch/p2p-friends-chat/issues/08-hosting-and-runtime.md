# Hosting platform, server runtime, and TURN provider decision

Type: grilling
Status: open
Blocked by: 03, 04, 07

## Question

Where does the server run, on what runtime, and which TURN provider does it use, at zero cost? The stack decision may rule some hosts out (a Node-only library cannot run on Workers). Decide the platform for the WebSocket hub, the platform for the static SPA (may be the same), the runtime (Node, Bun, or a proprietary edge runtime), the TURN provider and credential scheme, and the domain and TLS story. Record the free-tier limits the spec must respect and what happens when they are hit.
