# 93 · Flake: game tests read a moving game too late on a page drawing in software

Status: open
Type: flake

Seen 2026-11-22, the gate of #184 at 001e568 (run 45047144263, Chromium shard 6), first tries only; both passed on
the re-run:

- `skid.spec.ts:43` "Alice held on the grid through the countdown": 13.4 units from the grid at the go, against < 12.
  Her throttle is down through the countdown; the test reads her kart once it sees `play`, and a read of `__daveGame` on
  a page drawing its game in software takes from a third of a second to over one (measured on the dev box, 2026-11-22:
  40 reads of a lone page playing, 350 to 575 ms on average, up to 1.5 s). A second's driving is about 13 units.
- `clink.spec.ts:95` Alice's `me.at` was -2 where the test waits for -1 (15 s), after her grab on the second climb. The
  same test failed in the same section earlier the same day on `flake/81-picture-fetched-twice` (run 45039110999,
  line 93, `toBeLessThanOrEqual`), a branch without #184.

#184 (games side by side, game links answer only the newest offer) touches neither Skid nor Clink, nor the rounds, and
a single game mounts as before; the evidence cleared it, and the gate's one re-run passed.

Cause to find: both tests check a game in motion through page reads that a busy page answers late. The fix is likely in
the tests (read the position the game held at the go, as the game itself records it, rather than whenever the read
lands), but Clink's -2 wants a look at what `at` -2 means there first.
