import { expect, needHooks, test, type Friend } from './fixtures';
import { ALLOWANCE, type ClinkView } from '../src/core/clink';

// Clink (core/clink.ts, client/clink.ts): practice alone, then a match once a friend comes; stakes in, a grab paid on
// both screens, a double or nothing that keeps the stake, a tower that falls under the one still on it, the shop, the
// next climb; the match won by the one left when the other leaves. Chance is the leader's, rigged here through
// `window.__daveClinkRig` (a wobbly coin that always lands, then one that always topples); how the game plays over
// thousands of matches is test/clink.fun.test.ts's. E2E_SHOTS=<dir> keeps a screenshot of each step there, to look at.

const tile = (f: Friend) => f.page.locator('.shares .game');
const view = (f: Friend) => f.page.evaluate(() => (window as unknown as { __daveGame?: () => ClinkView }).__daveGame?.() ?? null);
/**
 * Every roll the leader's dice make comes out `v` (core/clinktable.ts, `rig`): after this coin of this round's climbs
 * (default: the next not seen yet), and every one of later rounds'. Whether the game was there to rig: not before its
 * chunk has loaded, and a rig that came too soon left that screen's coins to chance (ticket 93).
 */
const rig = (f: Friend, v: number | null, from?: [number, number]) => f.page.evaluate(([x, at]) => {
  const r = (window as unknown as { __daveClinkRig?: (v: number | null, from?: [number, number]) => void }).__daveClinkRig;
  r?.(x, at);
  return r !== undefined;
}, [v, from] as const);
const shots = process.env['E2E_SHOTS'];
const shot = async (f: Friend, name: string) => { if (shots) await f.page.screenshot({ path: `${shots}/${f.name}-${name}.png` }); };
const FELL = -3;

/** A friend who plays, in a browser with no GPU: see e2e/game.spec.ts, whose warnings these are. */
async function open(crowd: { open: (name: string) => Promise<Friend> }, name: string): Promise<Friend> {
  const f = await crowd.open(name);
  f.expectWarning(/^warning: \[JavaScript Warning: "Failed to create WebGL context: WebGL creation failed: \n\* AllowWebgl2:false restricts context creation on this system\. \(\)" \{file: "[^"]+" line: \d+\}\]$/);
  f.expectWarning(/^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels( \(this message will no longer repeat\))?$/);
  return f;
}

test('clink: practice alone, a match with a friend, a grab and a double seen by both, a fall, the shop, won when the other leaves', async ({ crowd }) => {
  test.setTimeout(150_000);
  const alice = await open(crowd, 'Alice');
  await needHooks(alice);
  const bob = await open(crowd, 'Bob');
  await alice.join();
  await bob.join();

  // Alone, the tower goes up all the same: practice.
  await alice.page.getByRole('button', { name: 'Play Clink' }).click();
  await expect.poll(async () => (await view(alice))?.climb?.c ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  expect((await view(alice))!.phase).toBe('wait');
  await expect(tile(alice).locator('.bonk-banner')).toContainText('Practice');
  await shot(alice, '1-practice');
  expect(await rig(alice, 0.5)).toBe(true);
  await expect(tile(bob)).toContainText('1 friend plays. Click to play');
  await tile(bob).click();
  await expect.poll(() => rig(bob, 0.5), { timeout: 30_000, message: "Bob's game is there to rig" }).toBe(true);
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.connected, { timeout: 30_000, message: `${f.name}'s game link opens` }).toBe(1);

  // The match: the first climb's stakes open; Alice puts all of hers on, Bob keeps to half.
  for (const f of [alice, bob]) await expect.poll(async () => { const v = await view(f); return v?.phase === 'play' && v.playing && v.climb?.c === 1 && v.climb.open; }, { timeout: 20_000 }).toBe(true);
  await tile(alice).getByRole('button', { name: 'All', exact: true }).click();
  await shot(alice, '2-stakes');
  // All of hers, half of his: what they started with, and the allowance that came in while the stakes were open.
  await expect.poll(async () => (await view(alice))!.me.at, { timeout: 15_000 }).toBe(-1);
  const staked = (await view(alice))!.me.stake;
  expect(staked).toBeGreaterThanOrEqual(1000);
  expect(staked).toBeLessThan(1150);
  await expect.poll(async () => (await view(bob))!.me.at).toBe(-1);
  expect(Math.abs((await view(bob))!.me.stake - staked / 2)).toBeLessThan(40);
  await expect.poll(async () => (await view(bob))!.others[0]?.at).toBe(-1);

  // A coin up, Alice grabs; Bob is still on, and the tower falls under him: his stake gone, the half he kept his (and
  // the allowance meanwhile). The tower would stand to the top otherwise, which a slow machine could get to first.
  await expect.poll(async () => (await view(alice))!.climb?.h ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await tile(alice).getByRole('button', { name: /^Grab/ }).click();
  // Each moment taken before its read: the allowance after it is counted from no later than it was.
  const ridingAt = Date.now();
  const riding = (await view(bob))!.me;
  // Her grab and the tower as she saw it, read before the rigs: a page drawing in software takes up to a second a read,
  // and the climb may be over by the last of them (ticket 93).
  let seen: ClinkView | null = null;
  await expect.poll(async () => { const v = (await view(alice))!; if (v.me.at >= 1) seen = v; return seen !== null; }, { message: "Alice's grab" }).toBe(true);
  const grabbed = seen!.me;
  const tower = seen!.climb!;
  // The coin after next topples it: the same coin on both screens, which neither has seen land.
  const topples: [number, number] = [tower.c, tower.h + 1];
  expect(await rig(alice, 0, topples)).toBe(true);
  expect(await rig(bob, 0, topples)).toBe(true);
  // From the next climb on, every coin lands again: rigged before the fall, which a page drawing in software may read
  // only once the next climb has begun (ticket 93).
  const fell = tower.c;
  expect(await rig(alice, 0.5, [fell + 1, 0])).toBe(true);
  expect(await rig(bob, 0.5, [fell + 1, 0])).toBe(true);
  expect(riding.at).toBe(-1);
  expect(grabbed.won).toBeGreaterThanOrEqual(Math.floor(staked * 1.2));
  expect(grabbed.chips).toBeGreaterThanOrEqual(grabbed.won);
  // Fallen, or on to the next climb with his stake not in yet: the chips he kept are his until its stakes close.
  let fallen: ClinkView['me'] | null = null;
  await expect.poll(async () => {
    const v = (await view(bob))!;
    if (v.me.at === FELL || ((v.climb?.c ?? 0) > fell && v.me.stake === 0)) fallen = v.me;
    return fallen !== null;
  }, { timeout: 15_000, message: 'the tower falls under Bob' }).toBe(true);
  fallen = fallen!;
  expect(fallen.chips).toBeGreaterThanOrEqual(riding.chips);
  expect(fallen.chips).toBeLessThanOrEqual(riding.chips + ALLOWANCE * ((Date.now() - ridingAt) / 1000 + 1));

  // The shop: Alice buys a lucky charm with what she won.
  await tile(alice).getByRole('button', { name: /^Lucky charm/ }).click();
  await expect.poll(async () => (await view(alice))!.me.levels[1]).toBe(1);
  // Half from the next climb on: chips kept back.
  await tile(alice).getByRole('button', { name: '½', exact: true }).click();
  await shot(alice, '3-grabbed');
  await shot(bob, '3-fell');

  // The next climb: Alice grabs again, and goes double or nothing on what that won, her stake hers either way.
  for (const f of [alice, bob]) await expect.poll(async () => (await view(f))?.climb?.c, { timeout: 15_000 }).toBe(2);
  await expect.poll(async () => (await view(alice))!.me.at, { timeout: 15_000 }).toBe(-1);
  await expect.poll(async () => (await view(alice))!.climb?.h ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await tile(alice).getByRole('button', { name: /^Grab/ }).click();
  await expect.poll(async () => (await view(alice))!.me.at).toBeGreaterThanOrEqual(1);
  const againAt = Date.now();
  const again = (await view(alice))!.me;
  await expect.poll(async () => (await view(bob))!.others[0]?.at, { message: "Bob sees Alice's grab" }).toBe(again.at);
  const profit = again.won - again.stake;
  expect(profit).toBeGreaterThan(0);
  await tile(alice).getByRole('button', { name: /^Double or nothing/ }).click();
  await expect.poll(async () => (await view(alice))!.me.flip).not.toBe(0);
  const flipped = (await view(alice))!.me;
  const want = again.chips + (flipped.flip === 1 ? profit : -profit);
  expect(flipped.chips).toBeGreaterThanOrEqual(want);
  expect(flipped.chips).toBeLessThanOrEqual(want + ALLOWANCE * ((Date.now() - againAt) / 1000 + 1));
  await expect.poll(async () => (await view(bob))!.others[0]?.flip, { message: "Bob sees how Alice's double went" }).toBe(flipped.flip);
  await shot(alice, '4-doubled');
  await shot(bob, '4-riding');

  // Bob leaves the game: Alice is the one left in the match, and wins it.
  await tile(bob).getByRole('button', { name: 'Leave game' }).click();
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 15_000 }).toBe('over');
  expect((await view(alice))!.winner).not.toBeNull();
  await expect(tile(alice).locator('.bonk-banner')).toHaveText('🏆 You win!');
  await shot(alice, '7-won');
  await expect.poll(async () => (await view(alice))?.phase, { timeout: 20_000 }).toBe('wait');
});
