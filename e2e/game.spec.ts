import { expect, needHooks, test, type Friend } from './fixtures';
import type { GameView } from '../src/core/bonk';

// The call's games (client/game.ts, ADR 0014): started from the call in one click, joined from their tiles beside the shares,
// played over game links between the players (client/gamelinks.ts), never through the server.

const tile = (f: Friend) => f.page.locator('.shares .game');
/**
 * A friend who plays, in a browser that draws with no GPU. Headless Chromium composites the page in software, and reads
 * every frame of the game's WebGL canvas back to do so, which its GL driver notes, for the first such canvas of the
 * browser. A browser with a GPU composites it there and reads nothing back.
 */
async function open(crowd: { open: (name: string) => Promise<Friend> }, name: string): Promise<Friend> {
  const f = await crowd.open(name);
  // Headless Firefox on a machine with no GPU gives a page no WebGL 2 (this dev box, 2026-11-21): the game is played
  // blind there, as in any browser without it, and Firefox says why it gave none.
  f.expectWarning(/^warning: \[JavaScript Warning: "Failed to create WebGL context: WebGL creation failed: \n\* AllowWebgl2:false restricts context creation on this system\. \(\)" \{file: "[^"]+" line: \d+\}\]$/);
  f.expectWarning(/^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels( \(this message will no longer repeat\))?$/);
  return f;
}
const view = (f: Friend) => f.page.evaluate(() => (window as unknown as { __daveGame?: () => GameView }).__daveGame?.() ?? null);

test('a game: started from the call in one click, joined from its tile, rounds counted down and played, a bonk felt on both sides', async ({ crowd }) => {
  test.setTimeout(120_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  const carol = await crowd.open('Carol');
  await alice.join();
  await bob.join();

  // One click in the call starts it, for Alice; it shows for everyone, as a share does.
  await alice.page.getByRole('button', { name: /Play Bonk/ }).click();
  await expect(tile(alice).locator('.bonk')).toBeVisible();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 30_000 }).toBe('wait');
  await expect(tile(alice).locator('.bonk-banner')).toContainText('Waiting for a friend');
  await expect(tile(bob)).toContainText('1 friend plays. Click to play');
  await expect(tile(carol)).toContainText('Join the call to play');
  await tile(carol).click(); // not in the call: nothing
  await expect(tile(carol).locator('.bonk')).toHaveCount(0);
  // In the call, the button joins the game going on rather than starting another.
  await expect(bob.page.getByRole('button', { name: /Join Bonk/ })).toBeVisible();

  // Bob clicks the tile: in. Their apps link up, and the round is counted down and played.
  await tile(bob).click();
  await expect(tile(bob).locator('.share-faces .face')).toHaveCount(2);
  await expect(tile(carol).locator('.share-faces .face')).toHaveCount(2);
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.connected, { timeout: 30_000, message: `${f.name}'s game link opens` }).toBe(1);
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v && v.round >= 1 && (v.phase === 'count' || v.phase === 'play') && v.playing; }, { timeout: 15_000 }).toBe(true);
  // The same leader for both.
  const [a, b] = [(await view(alice))!, (await view(bob))!];
  expect(a.leader).toBe(b.leader);
  await expect.poll(async () => (await view(bob))?.phase, { timeout: 10_000 }).toBe('play');

  const aliceWho = (await view(bob))!.others[0]!.key.slice(0, 11); // as the game's frames carry a player (core/bonk.ts, `whoOf`)
  const bobWho = (await view(alice))!.others[0]!.key.slice(0, 11);

  // Alice rolls into Bob, who stands still: the bonk sends him off the floe, and Alice wins the round, on both screens.
  // Either app may work the bonk out (core/bonk.ts, `bonk`, `HitFrame`), as the timing of the two apps decides; the
  // knock's sums are test/game.test.ts's.
  await tile(alice).locator('.bonk').click();
  const bobFrom = (await view(bob))!.me;
  const toward = bobFrom.z > (await view(alice))!.me.z ? 'ArrowDown' : 'ArrowUp';
  await alice.page.keyboard.down(toward);
  await expect.poll(async () => { const me = (await view(bob))!.me; return !me.alive || Math.abs(me.z - bobFrom.z) > 0.5; }, { timeout: 10_000, intervals: [50], message: 'Bob is pushed' }).toBe(true);
  await alice.page.keyboard.up(toward);
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))!.wins, { timeout: 15_000, message: `${f.name} sees Alice win` }).toEqual({ [aliceWho]: 1 });
  // The winner is said for a few seconds, and the wins stay up.
  await expect(tile(alice).locator('.bonk-board')).toHaveText('You 🏆');
  await expect(tile(bob).locator('.bonk-board')).toHaveText('Alice 🏆');

  // The next round: Alice rolls right, and Bob sees her ball go.
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v?.phase === 'play' && v.round === 2; }, { timeout: 20_000 }).toBe(true);
  const before = (await view(bob))!.others[0]!.x;
  await alice.page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await view(bob))!.others[0]!.x, { timeout: 5000 }).toBeGreaterThan(before + 1);
  // On off the floe: Bob wins this one.
  await expect.poll(async () => (await view(alice))!.me.alive, { timeout: 10_000 }).toBe(false);
  await alice.page.keyboard.up('ArrowRight');
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))!.wins, { timeout: 15_000 }).toEqual({ [aliceWho]: 1, [bobWho]: 1 });
  await expect(tile(bob).locator('.bonk-board li')).toHaveText(['Alice 🏆', 'You 🏆']);

  // Alice leaves the game; it goes on for Bob, alone, waiting for a friend.
  await tile(alice).getByRole('button', { name: 'Leave game' }).click();
  await expect(tile(alice)).toContainText('1 friend plays. Click to play');
  await expect.poll(async () => (await view(bob))?.connected, { timeout: 15_000 }).toBe(0);
  await expect.poll(async () => (await view(bob))?.phase, { timeout: 15_000 }).toBe('wait');

  // Bob leaves the call: the game ends with him.
  await bob.page.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(tile(alice)).toHaveCount(0);
  await expect(alice.page.getByRole('button', { name: /Play Bonk/ })).toBeVisible();
});

test('a game link opens though its first offer was answered too late: only the newest offer is answered', async ({ crowd }) => {
  // CI, 2026-11-22: a page busy drawing (three pages draw their games in software on a runner) answered an offer after
  // its link's 15 s, when the offering side had offered again. It answered both, and the late answer was taken for the
  // new offer's, which no link then matched until the next try. Here the answering side gets every game link frame late:
  // all of them at once, once the second offer is out, as a page that did not run for a while does.
  test.setTimeout(120_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  await alice.join();
  await bob.join();
  await alice.page.getByRole('button', { name: /Play Bonk/ }).click();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 30_000 }).toBe('wait');
  // Whoever has the greater key answers (client/gamelinks.ts): hold what reaches either until two offers have.
  let offers = 0;
  const held: Array<() => void> = [];
  const hold = (frame: string, pass: (frame: string) => void): string | null => {
    if (!frame.startsWith('{"t":"link"') || !frame.includes('"link":"game-')) return frame;
    if (frame.includes('"type":"offer"')) offers++;
    held.push(() => pass(frame));
    if (offers === 2) { alice.wire.down = bob.wire.down = null; for (const f of held.splice(0)) f(); }
    return null;
  };
  alice.wire.down = bob.wire.down = hold;
  await tile(bob).click();
  await expect.poll(() => offers, { timeout: 40_000, message: 'the offering side offers again' }).toBe(2);
  // The link opens, and the first offer was never answered: an answer to it would have been taken for the second's, and
  // the link opened only on another try (Chromium, once the wrong one failed) or not at all (Firefox, whose ICE then
  // failed). Answering every offer, the link opens with as many answers as offers; skipping the first, with fewer, however
  // many tries a slow link takes.
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.connected, { timeout: 45_000, message: `${f.name}'s game link opens` }).toBe(1);
  const sent = (type: string) => [alice, bob].flatMap((f) => f.wire.log.filter((l) => l.dir === 'up' && l.frame.includes('"link":"game-') && l.frame.includes(`"type":"${type}"`))).length;
  expect(sent('answer')).toBeLessThan(sent('offer'));
});

test('games of different kinds go on side by side, each linking only its own players, and a click on another moves a friend over', async ({ crowd }) => {
  test.setTimeout(180_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  const carol = await open(crowd, 'Carol');
  const of = (f: Friend, name: string) => f.page.locator(`.shares .game[data-game="${name}"]`);
  /** The game a friend plays, as its view says (Bonk's names none), and how many links it has open. */
  const links = async (f: Friend) => { const v = await view(f) as { game?: string; connected: number } | null; return v && `${v.game ?? 'bonk'}:${v.connected}`; };
  /**
   * Three pages drawing their games in software slow one another down on a CI runner, a page by 15 s at times (the gate,
   * 2026-11-22): long enough for a link's first try to run out, and the next to open it.
   */
  const LINKS_OPEN = 60_000;
  await alice.join();
  await bob.join();
  await carol.join();

  // Alice plays Bonk; Bob, with Bonk going on, may join it or start Clink beside it.
  await alice.page.getByRole('button', { name: /Play Bonk/ }).click();
  await expect(bob.page.getByRole('button', { name: /Join Bonk/ })).toBeVisible();
  await bob.page.getByRole('button', { name: /Play Clink/ }).click();
  await expect(of(carol, 'bonk')).toContainText('1 friend plays. Click to play');
  await expect(of(carol, 'clink')).toContainText('1 friend plays. Click to play');
  // Playing one, Alice is offered the other in its tile, not in the call's buttons.
  await expect(of(alice, 'clink')).toContainText('Click to play this instead');
  await expect(alice.page.getByRole('button', { name: /Join Clink/ })).toHaveCount(0);

  // Carol joins Clink: linked to Bob, and not to Alice, whose Bonk goes on waiting for a friend.
  await of(carol, 'clink').click();
  await expect(of(alice, 'clink').locator('.share-faces .face')).toHaveCount(2);
  await expect(of(alice, 'bonk').locator('.share-faces .face')).toHaveCount(1);
  for (const f of [bob, carol]) await expect.poll(() => links(f), { timeout: LINKS_OPEN, message: `${f.name}'s Clink link opens` }).toBe('clink:1');
  await expect.poll(() => links(alice), { timeout: 15_000 }).toBe('bonk:0');
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 15_000 }).toBe('wait');

  // Carol clicks Bonk's tile: out of Clink, into Bonk with Alice. Bob is left in Clink alone.
  await of(carol, 'bonk').click();
  await expect(of(bob, 'bonk').locator('.share-faces .face')).toHaveCount(2);
  await expect(of(bob, 'clink').locator('.share-faces .face')).toHaveCount(1);
  for (const f of [alice, carol]) await expect.poll(() => links(f), { timeout: LINKS_OPEN, message: `${f.name}'s Bonk link opens` }).toBe('bonk:1');
  await expect.poll(() => links(bob), { timeout: 15_000 }).toBe('clink:0');

  // Bob leaves Clink: it ends, and Bonk goes on.
  await of(bob, 'clink').getByRole('button', { name: 'Leave game' }).click();
  await expect(of(alice, 'clink')).toHaveCount(0);
  await expect(of(bob, 'bonk')).toContainText('2 friends play. Click to play');
  await expect(bob.page.getByRole('button', { name: /Play Clink/ })).toBeVisible();
});

test('a friend back from a gap, moved over to the game of a kind started since, comes into it anew, without the rounds of the one that ended', async ({ crowd }) => {
  test.setTimeout(180_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  const carol = await open(crowd, 'Carol');
  await alice.join();
  await bob.join();
  await carol.join();

  // Carol and Alice play a Bonk; Alice rolls off the floe, and Carol wins its first round.
  await carol.page.getByRole('button', { name: /Play Bonk/ }).click();
  await tile(alice).click();
  for (const f of [alice, carol]) await expect.poll(async () => { const v = await view(f); return v?.phase === 'play' && v.round === 1 && v.connected === 1; }, { timeout: 45_000 }).toBe(true);
  const carolWho = (await view(alice))!.others[0]!.key.slice(0, 11);
  await tile(alice).locator('.bonk').click();
  await alice.page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await view(alice))!.me.alive, { timeout: 15_000 }).toBe(false);
  await alice.page.keyboard.up('ArrowRight');
  await expect.poll(async () => (await view(carol))!.wins, { timeout: 15_000 }).toEqual({ [carolWho]: 1 });
  // On to round 2, so Carol's Bonk knows a newer round than the one the others start next will for a while: brought
  // along, it would lead theirs whatever the keys.
  await expect.poll(async () => (await view(carol))!.round, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  // Carol's socket goes away; she stays in the call, in her Bonk. Meanwhile Alice leaves it, and with Bob starts another.
  await carol.wire.cut();
  await expect(carol.away).toBeVisible();
  await tile(alice).getByRole('button', { name: 'Leave game' }).click();
  await expect(tile(alice)).toHaveCount(0, { timeout: 30_000 }); // the Room forgot Carol's with her socket
  await alice.page.getByRole('button', { name: /Play Bonk/ }).click();
  await tile(bob).click();
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v?.round === 1 && v.connected === 1; }, { timeout: 45_000 }).toBe(true);

  // Carol is back: the others' Bonk has more players, so she moves over to it, and her game starts anew in it, as a
  // newcomer's. Her old round and its win stay behind, and the others' rounds go on under their own leader.
  carol.wire.restore();
  await carol.connected();
  await expect(tile(carol).locator('.share-faces .face')).toHaveCount(3, { timeout: 30_000 });
  // Slow to link, as three pages drawing in software on a CI runner are (see the test before).
  await expect.poll(async () => (await view(carol))?.connected, { timeout: 60_000, message: 'Carol links up with both' }).toBe(2);
  // Not the win from before: Carol's game follows the others' rounds, and theirs do not take hers.
  for (const f of [carol, alice, bob]) expect((await view(f))!.wins[carolWho], `${f.name} sees no win of Carol's`).toBeUndefined();
});

test('Bonk followed: the ball rolls to where the mouse is held, the right button dashes, and the pick is kept', async ({ crowd }) => {
  test.setTimeout(90_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  await alice.join();
  await alice.page.getByRole('button', { name: /Play Bonk/ }).click();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 30_000 }).toBe('wait');

  // The drag stick to start with; the mouse held does nothing then.
  const game = tile(alice).locator('.bonk');
  const box = (await game.boundingBox())!;
  const from = (await view(alice))!.me;
  await alice.page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await alice.page.mouse.down();
  await alice.page.waitForTimeout(500);
  await alice.page.mouse.up();
  expect((await view(alice))!.me.x).toBeCloseTo(from.x, 1);

  // Follow: held still right of the middle, on the floe, the ball rolls there and stops on the spot. The spot stays
  // where it went down, though the camera follows the ball a little: worked out again as the ball goes, it would go on
  // ahead of the ball, off the floe.
  await tile(alice).getByRole('button', { name: 'Controls: stick' }).click();
  await expect(tile(alice).getByRole('button', { name: 'Controls: follow' })).toBeVisible();
  expect((await view(alice))!.controls).toBe('follow');
  await alice.page.mouse.move(box.x + box.width * 0.65, box.y + box.height / 2);
  await alice.page.mouse.down();
  await expect.poll(async () => (await view(alice))!.aim).not.toBeNull();
  const spot = (await view(alice))!.aim!;
  expect(spot.x).toBeGreaterThan(from.x + 2);
  await expect.poll(async () => { const v = (await view(alice))!; return Math.hypot(v.me.x - spot.x, v.me.z - spot.z); }, { timeout: 5000 }).toBeLessThan(0.3);
  await alice.page.waitForTimeout(1000);
  const there = (await view(alice))!;
  expect(there.aim).toEqual(spot);
  expect(there.me.alive).toBe(true);
  expect(Math.hypot(there.me.x - spot.x, there.me.z - spot.z)).toBeLessThan(0.3); // stopped on it, not swinging round it
  await alice.page.mouse.up();

  // The right button, left of the middle: a dash that way.
  expect((await view(alice))!.me.dashAt).toBeNull();
  await alice.page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2, { button: 'right' });
  await expect.poll(async () => (await view(alice))!.me.dashAt, { timeout: 5000 }).not.toBeNull();
  await expect.poll(async () => (await view(alice))!.me.x, { timeout: 5000 }).toBeLessThan(there.me.x - 1);

  // Kept: a game started again follows still.
  await tile(alice).getByRole('button', { name: 'Leave game' }).click();
  await expect(tile(alice)).toHaveCount(0);
  await alice.page.getByRole('button', { name: /Play Bonk/ }).click();
  await expect(tile(alice).getByRole('button', { name: 'Controls: follow' })).toBeVisible();
});
