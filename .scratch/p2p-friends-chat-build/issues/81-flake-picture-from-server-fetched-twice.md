# 81 · Flake: a picture coming from the server asked for one of its pieces twice

Status: cause found 2026-11-22 (the test's claim): a socket the network dropped under Bob's first `fetch`, asked again
on the next, as the app should; fixed in the test; fixed once its ledger row stops growing. The picture that never
showed (11-17) is another cause: ticket 92
Type: flake

Seen 2026-11-13, the preview run of #142 at 25f334f (run 43480133149, Firefox shard 2), passed on its retry:
`attachment.spec.ts:1034` "ADR 0009: a picture sent while nobody else was there comes from the server, sealed, once its
sender is gone". #142 changes YouTube cards only, nothing on the pull path. The same test failed once before, 2026-11-05
(run 42064671698), on a different line (`toHaveCount`).

```
Expected: 3
Received: 4
> 1056 |   expect(bob.wire.frames('up', 'fetch').length).toBe(pieces);
```

The picture came whole and checked (the line before passed): Bob's app sent one `fetch` more than the picture has
pieces.

## Next
The failed try's trace: which piece was asked twice, and why. A fetch sent again after a slow answer (a timeout on a
preview's Store, which "takes a moment") would be the app doing what it should, and the claim should be "at least one per
piece, the picture once"; two pulls started for the one picture would be the app's bug.

2026-11-17: the preview run of #157 at 6616e80 (run 44168521032, Firefox shard 3), passed on its retry: the same test
(`attachment.spec.ts:1094`), another step: the picture never showed in Bob's log within 30 s
(`.chat-log .att-media img:not(.att-preview)`, 0 of 1). #157 makes a YouTube card's title a link: nothing on pulls or
the Store. The same run had a socket refused by the preview Worker (ticket 55).

2026-11-22: the gate run of #181 (Skid) at 764b8c5 (run 44967075281, Chromium shard 4): `attachment.spec.ts:1122`, the
same claim as the first sighting, `fetch` frames 4 where the picture has 3 pieces. #181 adds a game: nothing on pulls or
the Store. One re-run of the failed job passed (`docs/agents/flakes.md`).

## Comments

### 2026-11-22: the cause, from the failed tries' wire logs and the preview's logs
**The extra `fetch` is piece 0 asked again on a new socket, after the network dropped the first one before its answer
came.** One pull at a time, never two: the app did what it should, and the test's claim ("exactly one `fetch` per
piece") was wrong.

Bob's frames in both "4 for 3" tries (`Bob-wire.json`, 11-13 Firefox and 11-22 Chromium alike):
`challenge, auth, welcome, presence, sync, history, fetch n=0`, then his socket ends with 1006 from the server side
after those 7 frames (`closes`), then `challenge … fetch 0, piece 0, fetch 1, piece 1, fetch 2, piece 2`. No `piece` came
on the first socket. In the trace (11-22), Bob's page logs "let in after 1 lost socket" about 1 s after his first
`fetch`, and the picture shows 1.5 s later.

The Room's side (Workers Logs of `dave-pr-181`, 11-22; the room's Durable Object found by its sockets' times): it took
Bob's first socket, read his `fetch` (303 ms, the Store's read of the piece) and answered, and never heard that socket
end. It logs a "socket end" line for every close the runtime reports, and has none for it. Alice's first socket in the
same try died the same way: the Room read only her `auth` and `sync`, never her `file` and first `piece`, and she sent
both again on her next socket. That is ticket 51's and 54's drop: one socket cut between the browser and the Room,
1006, unheard by the Room, back on the next try. (Seen, not proven: each of the three drops came when a 1.4 MB frame
was due on that socket for the first time, a piece up or a piece down. Other tests' big frames cross without a drop.
The logs of 11-13 have expired.)

What the app does with it (`client/room.ts`): `lost()` answers every `fetch` waiting with null, `fromServer` fails as
"lost", and with no socket let in the file is due again as soon as the next one is (`retryAt: now`). The new pull starts
from piece 0. On one socket a piece is asked twice only after a `fetch` went unanswered for 20 s (`FETCH_TIMEOUT_MS`),
which these runs did not come near.

**On demand:** the new test "a picture from the server whose socket drops under a fetch is asked again on the next
socket, once" holds back the Room's first `piece` answer and cuts Bob's socket then. Bob sends 4 `fetch`es for 3
pieces, as in CI, and the picture shows. It claims no count: a drop of the network's own on top would add one more. Local build, single tests: Chromium 4 runs, Firefox 1, all green.

**The fix (test):** `expectOnePullOf` counts the `fetch`es socket by socket (each starts with the Room's `challenge`):
on each socket the pieces in order from the first, none twice; on the last, every piece once. Two pulls of the one
picture would still fail it. The ledger row of ticket 81 is now every failure of this test but the picture not showing
(ticket 92's), and the new test's. Both CI logs above pass it: `[[0], [0, 1, 2]]`.

The other two sightings are not this:
- 11-05 (run 42064671698, `toHaveCount`): the test before f2040d6, which closed Alice once her pieces were sent, not
  once the server said it kept them. f2040d6 added that wait. The artifacts have expired, so this is likely, not shown.
- 11-17 (run 44168521032, Firefox): Bob's history came back empty. The Store threw for a moment while Alice sent the
  picture, and its announcement was never kept: ticket 92. The ledger row with `toHaveCount` now points there.

