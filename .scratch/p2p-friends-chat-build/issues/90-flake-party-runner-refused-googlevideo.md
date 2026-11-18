# 90 · Flake: a host of YouTube's videos refused one connection, a console line the party tests did not expect

Status: fixed in the test (party.spec.ts `open`); fixed once its ledger row stops growing
Type: flake

Seen 2026-11-18, the gate of #158 at ddf8f62 (run 44274021733, `e2e-local`, Chromium shard 4), both tries:
`party.spec.ts:226` "a friend who joins a paused party finds it paused, where it is, and it plays on from there for
everyone, a newcomer to the room too", on its console check:

```
Alice: error: Failed to load resource: net::ERR_CONNECTION_REFUSED (https://rr1---sn-uphho-hqae.googlevideo.com/videoplayback?…)
```

the same for Bob and Carol. #158 adds the `/yt` rolling line to the chat log: nothing on watch parties or the player.
The same test passed in the gate of ci/explicit-suite the same morning (run 44272211754). Seen again the same evening on
the gate of #160 (run 44374327445, `e2e-local`, Chromium shard 4, both tries, the same host), a PR of tickets only.

The party tests play YouTube's real player. In both runs everything the test checks passed (the tries took 18 to 20 s):
each friend's player had one connection refused by that host, and played after it (from another host, most likely:
the logs do not say). Only the console check
failed, on a line nobody expected. Not a runner YouTube refuses (the 403s `youtubePlays` skips on, 2026-11-15): this
one YouTube served.

## Done (2026-11-18)
`open` expects `net::ERR_CONNECTION_REFUSED` for a `*.googlevideo.com` resource; nothing else changes, so a player that
does not play still fails the test. Checked locally with a route refusing each browser's first request to
googlevideo.com and passing the rest: the test failed on the console check alone before, as in CI, and passes after.
A runner where every such connection is refused would fail on the player not playing; not seen, not handled.
