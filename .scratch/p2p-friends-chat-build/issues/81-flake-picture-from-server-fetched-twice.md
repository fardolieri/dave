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
