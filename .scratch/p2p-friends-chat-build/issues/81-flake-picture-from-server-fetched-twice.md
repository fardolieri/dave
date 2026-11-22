# 81 · Flake: a picture coming from the server asked for one of its pieces twice

Status: open; cause not looked for
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
