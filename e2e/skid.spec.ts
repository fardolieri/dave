import { expect, needHooks, test, type Friend } from './fixtures';
import type { SkidView } from '../src/core/skid';

// Skid, the third game (core/skid.ts, client/skid.ts): a race started from the call and joined from its tile, counted
// down on the grid, each kart seen by the other, places on both screens, and the race ended when one of two leaves it.
// A whole race of three laps is test/skid.test.ts's, driven there by a steady hand.

const tile = (f: Friend) => f.page.locator('.shares .game');
const view = (f: Friend) => f.page.evaluate(() => (window as unknown as { __daveGame?: () => SkidView }).__daveGame?.() ?? null);

/** A friend who plays, in a browser with no GPU: see e2e/game.spec.ts, whose warnings these are. */
async function open(crowd: { open: (name: string) => Promise<Friend> }, name: string): Promise<Friend> {
  const f = await crowd.open(name);
  f.expectWarning(/^warning: \[JavaScript Warning: "Failed to create WebGL context: WebGL creation failed: \n\* AllowWebgl2:false restricts context creation on this system\. \(\)" \{file: "[^"]+" line: \d+\}\]$/);
  f.expectWarning(/^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels( \(this message will no longer repeat\))?$/);
  return f;
}

test('skid: a race counted down on the grid, each kart seen by the other, places on both screens, ended when one leaves', async ({ crowd }) => {
  test.setTimeout(150_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  await alice.join();
  await bob.join();

  await alice.page.getByRole('button', { name: 'Play Skid' }).click();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 30_000 }).toBe('wait');
  await expect(tile(bob)).toContainText('1 friend plays. Click to play');
  await tile(bob).click();
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.connected, { timeout: 30_000, message: `${f.name}'s game link opens` }).toBe(1);

  // The countdown: both on the grid, held there, the throttle down or not.
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v?.phase === 'count' && v.playing; }, { timeout: 15_000 }).toBe(true);
  const grid = (await view(alice))!.me;
  await tile(alice).locator('.bonk').click();
  await alice.page.keyboard.down('ArrowUp');

  // Go: Alice drives off, Bob stays; Bob sees her kart go, and both screens put her first. Held on the grid through the
  // countdown, her throttle down all along, she is still near it at the go: a few seconds' driving would be 40 units on.
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 15_000, intervals: [50] }).toBe('play');
  const atGo = (await view(alice))!.me;
  expect(Math.hypot(atGo.x - grid.x, atGo.z - grid.z), 'Alice held on the grid through the countdown').toBeLessThan(12);
  await expect.poll(async () => (await view(bob))?.phase, { timeout: 15_000 }).toBe('play');
  const bobFrom = (await view(bob))!.me;
  await expect.poll(async () => { const o = (await view(bob))!.others[0]!; return Math.hypot(o.x - grid.x, o.z - grid.z); }, { timeout: 5000, message: "Bob sees Alice's kart go" }).toBeGreaterThan(10);
  await alice.page.keyboard.up('ArrowUp');
  await expect.poll(async () => (await view(alice))!.place).toBe(1);
  await expect.poll(async () => (await view(bob))!.place).toBe(2);
  expect(Math.hypot((await view(bob))!.me.x - bobFrom.x, (await view(bob))!.me.z - bobFrom.z)).toBeLessThan(1);
  await expect(tile(alice).locator('.skid-stats')).toContainText('Lap 1/3 · 1st of 2');
  await expect(tile(bob).locator('.skid-stats')).toContainText('2nd of 2');

  // Bob leaves the game: one racer left and nobody finished, the race is over with no winner, and Alice waits again.
  await tile(bob).getByRole('button', { name: 'Leave game' }).click();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 15_000 }).toBe('over');
  expect((await view(alice))!.winner).toBeNull();
  await expect(tile(alice).locator('.bonk-banner')).toHaveText('Nobody finished');
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 20_000 }).toBe('wait');
});
