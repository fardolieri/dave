import { expect, needHooks, test, type Friend } from './fixtures';
import type { GameView } from '../src/core/bonk';

// The call's game (client/game.ts, ADR 0014): started from the call in one click, joined from its tile beside the shares,
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

  // The next round: Alice holds the mouse at the right of the game, over the sea, and her ball rolls there; Bob sees it
  // go.
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v?.phase === 'play' && v.round === 2; }, { timeout: 20_000 }).toBe(true);
  const before = (await view(bob))!.others[0]!.x;
  const box = (await tile(alice).locator('.bonk').boundingBox())!;
  await alice.page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await alice.page.mouse.down();
  await expect.poll(async () => (await view(bob))!.others[0]!.x, { timeout: 5000 }).toBeGreaterThan(before + 1);
  // On off the floe: Bob wins this one.
  await expect.poll(async () => (await view(alice))!.me.alive, { timeout: 10_000 }).toBe(false);
  await alice.page.mouse.up();
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
