# 93 · Flake: game tests read a moving game too late on a page drawing in software

Status: Clink's causes found 2026-11-22 and fixed in the test; Skid's still open
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

## Comments

2026-11-22, Clink: two causes, both in the test, read from the failed tries' traces (decoded `__daveGame` reads, trace
ms) and the code. Neither is the app's.

**1. A rig before the game was there** (the gate of #183, run 45039110999, `toBeLessThanOrEqual`, 645 against 595.83).
Bob's first `rig(bob, 0.5)` ran before his game's chunk had loaded, and did nothing: his click on the tile ended at
42404, the rig ran from 42405 to 42708, and his page's snapshot before it has no Clink HUD, the one after it has. The
hooks come with the game (`client/clink.ts`, `exposeHooks`), so `__daveClinkRig?.()` met `undefined`; the poll still
passed, as its `view` came after the game was there. Bob's coins went by chance:
- Riding, at 55972: chips 559, coin 2 landed, pot 40 on both screens.
- Coin 3, at 56987: Alice's HUD says "Pot 60" (a plain coin); Bob's view says `h=3 pot=0 gold=1 chips=630`, a golden
  coin that paid him the pot while he was on. Under a rig of 0.5 coin 3 cannot be golden.
- Fallen, at 58503: 645 = 559 + 60 + 26 (2.68 s of allowance). The bound, 559 + 10 × (2.683 + 1), counts right.

**2. The next climb rigged too late** (the gate of #184, run 45047144263, line 95, Alice's `at` -2 where -1 was
waited for). The rig that has every coin land again from the next climb on came after the shop, and the shop's clicks
were slow: "Lucky charm" took from 69955 to 73557, "½" from 74668 to 76828. Climb 2 had begun meanwhile, its stakes
closed (73879: Alice all in, chips 0), and the topple rig, which holds for every later climb too, toppled it under both:
at 77799 Alice is at -3 with 40 chips, Bob's view has her at -3 on climb 2.

The same cascade came up on the dev box at a load of 7 to 8: a Grab click of 4.5 s and four rigs of a second each, so
Alice's grab was read only once climb 1 was over (`at` -2), and in another run Bob's fall was read only on climb 2,
whose stakes then went in and fell too (`fallen.chips` 380 < `riding.chips` 624).

Fix (`e2e/clink.spec.ts`): `rig` says whether the game was there to rig; Bob's first one is polled until it was, and
every other one must have been. Alice's grab and the tower are read in one read before the rigs; the next climb's
landing rig goes in right after the topple rig, before the fall; Bob's fall is taken as his `at` FELL, or the next climb
with his stake not in yet, his chips still his until its stakes close. The shop moved to after the double or nothing:
between climbs Alice had the 2.6 s pause and 4 s of stakes to click it, and once climb 2's stakes were in, all of hers,
the charm's button was shut to her no chips (in #184's trace, her stake was in 0.3 s after the click ended).

Not fixed: on the dev box at that load even the first stakes can close before Alice's "All" lands (staked 541, not
1000 or more). Not seen on a runner. Skid's reading (above) is not looked at.
