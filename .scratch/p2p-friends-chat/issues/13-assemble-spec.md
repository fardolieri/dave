# Assemble the spec

Type: task
Status: resolved
Blocked by: 08, 09, 10, 12, 14, 15

## Question

Write the spec that is this map's destination, drawing every section from the resolved tickets and linking each decision to its ticket. Sections: overview and glossary reference, architecture (stack, hosting, TURN), access and identity, presence and text, voice and shares, UI (linking the prototype), failure and reconnection behaviour, free-tier limits and their consequences, out of scope. Decide where the spec lives in the repo and record it. The map is complete when this ticket is resolved.

## Answer

Done 2026-09-06. The spec lives at [spec.md](../spec.md) (`.scratch/p2p-friends-chat/spec.md`), following the local tracker convention that a feature's spec sits next to its map. It has eleven sections: overview, architecture (stack, media and signaling, hosting, TURN), access and identity, presence and text, wire protocol, voice and shares, user interface, failure and reconnection, free-tier limits, out of scope, and implementation order. Every section links the ticket or ADR that holds its reasoning; nothing in it is decided here for the first time. The glossary stays in `CONTEXT.md`, the three ADRs in `docs/adr/`, and the two prototypes on their branches as reference implementations to be rewritten, not promoted.
