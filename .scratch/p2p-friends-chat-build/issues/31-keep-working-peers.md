# 31 · A friend who loses the server stays while the connection to them works

Status: built on build/31-keep-working-peers, not yet shipped
Asked for 2026-09-27: Daniel's report of Sep 26 ("the UI showed that he is offline but we were still connected to him
and could hear him … once he wasn't shown at all … but we still heard something"). A friend whose server socket
drops is shown dimmed as "connection to server lost" and his connection was closed after 60 s whatever its state,
although voice and a running share never needed the server. Decided with Daniel: keep the dimmed row (he likes the
transparency), but never close a connection that works just because its owner lost the server.

## Built
- `client/call.ts`: when the grace period ends, the connection is closed only if it is not up
  (`connectionState !== 'connected'`). One that is up stays, dimmed, until the friend returns, says `left`, or the
  browser reports the link disconnected or failed; those branches already close a server-lost peer at once (spec §8,
  2026-09-08), since without his socket no ICE restart could be signalled. A closed tab or a dead line shows there
  within seconds (ICE consent checks).
- `core/mesh.ts`: `PEER_GRACE_MS` comment. Spec §8.1 amended.

## Verify
- `pnpm typecheck`, `pnpm test`, `pnpm e2e`.
- New e2e (`resilience.spec.ts`): Alice's server is cut; Bob shows her dimmed, still does after 65 s, still hears her;
  after the server returns she is an ordinary participant again. Fails on the old code (the row is gone at 60 s).
- Not found: why he once showed nowhere while still heard. Most likely the old 60 s close itself (he was then listed
  nowhere, being off the server), with the "something" a cue or the tail of his voice; not proven.
- Left as it is: a dimmed row has no badge or volume slider, and while off the server he cannot start a share or get
  fresh relay credentials.
