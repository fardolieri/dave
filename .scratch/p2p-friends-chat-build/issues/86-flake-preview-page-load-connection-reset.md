# 86 · Flake: loading a preview's page was reset by the network

Status: open; cause not looked for
Type: flake

Seen 2026-11-17, the preview run of #155 at c2cacf1 (run 44149735035, Chromium shard 6), passed on its retry:
`settings.spec.ts:538` "phone width: one column, the composer pinned to the bottom of the screen and usable". #155 adds
`/yt-search` to the Worker and `/yt` to the composer's send, nothing on loading the page. First sighting in the ledger.

```
Error: page.goto: net::ERR_CONNECTION_RESET at https://dave-pr-155.danielmittereder.workers.dev/
"Bob: exception: Failed to read the 'localStorage' property from 'Window': Access is denied for this document."
```

The page itself, a static file Cloudflare serves before the Worker runs, never came: the connection from the GitHub
runner to Cloudflare was reset. The exception follows from that: Bob's page was Chromium's error page, which has no
storage, when the fixture read it.

## Next
More sightings first: a reset now and then between a runner and Cloudflare is the network's; several in one run, or on
one runner, would say otherwise. If it stays rare, `crowd.open` could load the page once more on a connection reset,
claiming nothing about the app (the app is not loaded yet).
