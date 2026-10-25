# 62 · Flake: a reload right after a join cut off the noise filter's download, and Firefox logged it

Status: shipped 2026-10-25 to prod (06b732d, nightly e2e green first); fixed in the tests (`e2e/fixtures.ts`, `join()`)
Seen 2026-10-25: the nightly e2e run of master 8b4deaf (40191892619), Firefox, two shards, each passed on the retry, which
the flake-strict nightly counts as a failure (the release gate stayed shut):
- shard 3: `presence.spec.ts:78` "the room whose call I join goes to the top of the list, and stays there after a reload".
- shard 4: `resilience.spec.ts:208` "a Rejoin left for another room's call is not taken up by the next reload".

Both failed on the console check alone, with the same line from Alice:
"Failed to load ‘…/assets/rnnoise-little-….wasm’. A ServiceWorker intercepted the request and encountered an unexpected
error." (sw.js line 2).

## Cause
Both tests join a call and reload the page straight after. A join with a microphone fetches the noise filter's file
(client/voice.ts, `loadWasm`), served by the service worker from its cache. The reload ends the page while that response
is still being read, and Firefox reports the cut-off interception as an error of the page. Chromium says nothing. The
app is not at fault: the page that asked for the file is going away, and the next page fetches it again. A friend who
reloads right after joining sees nothing of it either (the console line only).

## Fix
Outcome 1 of ticket 35, fix the test: `join()` waits until the file has loaded (its resource timing entry), where the
page can remove noise and has it on, as every test's does by default. A join without a microphone fetches none; the
wait gives up after 5 s and the test goes on, the same as before.
