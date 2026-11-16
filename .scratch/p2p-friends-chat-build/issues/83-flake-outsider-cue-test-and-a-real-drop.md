# 83 · Flake: the outsider's cue test failed on a socket the network dropped, not on a cue

Status: open; the test is wrong (outcome 1 of ticket 35), the drop itself is ticket 51's
Type: flake

Seen 2026-11-16, the preview run of #151 at 682bdcc (run 43891354222, Chromium shard 2), passed on its retry:
`resilience.spec.ts:729` "a friend whose server socket drops and comes back plays no join cue for a friend in the room
but out of the call". The test is from a25eca8, a day before. #151 has each shard run two tests at a time against a
preview: the first run that did.

```
- Expected  [ "Alice", "Bob" ]
+ Received  [ "Bob", "Alice" ]
> 760 |   await expect.poll(() => carol.inCall()).toEqual(['Alice', 'Bob']);
```

## What the failed try shows
- Alice's wire: two of her sockets, to two rooms, closed from the server's side with 1006, 106 ms apart. The test cuts
  only Bob's. A 1006 from the server on a socket that was let in is the network dropping it, not the Room
  (`e2e/fixtures.ts`, `closes`; ticket 51).
- The trace: the drop came 0.8 s after `bob.wire.restore()`, as Bob's banner went. Alice was back within the second,
  and the Room then lists her behind Bob. Carol's list stayed "Bob, Alice" for the 20 s of the poll: right for what
  happened, and not what the test expects.

So the app did nothing wrong here. The test holds only while nobody's socket but Bob's drops, and says nothing for the
case, as its neighbours do (`wire.droppedSince`, three tests in this file and text.spec.ts).

## Next
- The test: when Alice's or Carol's socket dropped since the cut (`droppedSince`), the order and the cues are not this
  test's to judge; end there, as "a socket gone silent…" does for Bob.
- Not known: whether two tests at a time from one runner make the network's drops more frequent. One sighting says
  nothing. Before #151 the ledger has this kind at one at a time (tickets 51, 53, 57, 60). If rows of this kind grow
  after #151 lands, suspect it first.
- Noted, not explained: both sockets went in the same instant, just as Bob's came back.
