import { expect, needHooks, test, type Friend } from './fixtures';
import type { SplotchView } from '../src/core/splotch';
import { BOARD, PLAY_MS } from '../src/core/splotch';

// Splotch, the second game (core/splotch.ts, client/splotch.ts): started from the call, joined from its tile, a round
// painted by both and counted by the leader, the same count on both screens. Over game links, as every game is (ADR 0014).

const tile = (f: Friend) => f.page.locator('.shares .game');
const view = (f: Friend) => f.page.evaluate(() => (window as unknown as { __daveGame?: () => SplotchView }).__daveGame?.() ?? null);

/** A friend who plays, in a browser with no GPU: see e2e/game.spec.ts, whose warnings these are. */
async function open(crowd: { open: (name: string) => Promise<Friend> }, name: string): Promise<Friend> {
  const f = await crowd.open(name);
  f.expectWarning(/^warning: \[JavaScript Warning: "Failed to create WebGL context: WebGL creation failed: \n\* AllowWebgl2:false restricts context creation on this system\. \(\)" \{file: "[^"]+" line: \d+\}\]$/);
  f.expectWarning(/^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels( \(this message will no longer repeat\))?$/);
  return f;
}

test('splotch: a round painted by two, one of them fullscreen, each trail and splat on both boards, counted the same on both screens', async ({ crowd }) => {
  test.setTimeout(150_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  await alice.join();
  await bob.join();

  await alice.page.getByRole('button', { name: 'Play Splotch' }).click();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 30_000 }).toBe('wait');
  await expect(tile(bob)).toContainText('Splotch');
  await expect(tile(bob)).toContainText('1 friend plays. Click to play');
  await expect(bob.page.getByRole('button', { name: /Join Splotch/ })).toBeVisible();
  await tile(bob).click();
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.connected, { timeout: 30_000, message: `${f.name}'s game link opens` }).toBe(1);
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v?.phase === 'play' && v.playing; }, { timeout: 15_000 }).toBe(true);
  // The countdown cleared both boards.
  const aliceWho = (await view(bob))!.others[0]!.key.slice(0, 11);
  const bobWho = (await view(alice))!.others[0]!.key.slice(0, 11);

  // Alice goes fullscreen, and runs right there: her trail is on Bob's board as it is on hers.
  await tile(alice).getByRole('button', { name: 'Fullscreen' }).click();
  await expect.poll(() => alice.page.evaluate(() => document.fullscreenElement?.classList.contains('game') ?? false)).toBe(true);
  await alice.page.keyboard.down('ArrowRight');
  await expect.poll(async () => (await view(bob))!.tiles[aliceWho] ?? 0, { timeout: 5000 }).toBeGreaterThan(8);
  await alice.page.keyboard.up('ArrowRight');
  await tile(alice).getByRole('button', { name: 'Leave fullscreen' }).click();
  await expect.poll(() => alice.page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(async () => {
    const [a, b] = [(await view(alice))!.tiles[aliceWho] ?? 0, (await view(bob))!.tiles[aliceWho] ?? 0];
    return Math.abs(a - b) <= Math.max(3, a * 0.15);
  }, { timeout: 5000, message: "Alice's trail is the same on both boards, give or take a tile where frames came late" }).toBe(true);

  // Bob splats where he stands: a patch at once, on Alice's board too.
  await tile(bob).locator('.bonk').click();
  await bob.page.keyboard.press('Space');
  await expect.poll(async () => (await view(alice))!.tiles[bobWho] ?? 0, { timeout: 5000 }).toBeGreaterThan(12);

  // Time up: the leader counts its board, and both screens show its count and its winner.
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.phase, { timeout: PLAY_MS + 15_000, message: `${f.name}'s round ends` }).toBe('over');
  const [a, b] = [(await view(alice))!, (await view(bob))!];
  expect(a.scores).not.toBeNull();
  expect(a.scores).toEqual(b.scores);
  expect(a.winner).toEqual(b.winner);
  expect(a.wins).toEqual(b.wins);
  expect(Object.values(a.scores!).reduce((n, t) => n + t, 0)).toBeLessThanOrEqual(BOARD * BOARD);
  expect(a.scores![aliceWho]).toBeGreaterThan(8);
  expect(a.scores![bobWho]).toBeGreaterThan(12);
  const winner = a.winner === aliceWho ? 'Alice' : a.winner === bobWho ? 'Bob' : null;
  if (winner) {
    await expect(tile(alice).locator('.bonk-board')).toHaveText(winner === 'Alice' ? 'You 🏆' : 'Bob 🏆');
    await expect(tile(bob).locator('.bonk-board')).toHaveText(winner === 'Bob' ? 'You 🏆' : 'Alice 🏆');
  }
});
