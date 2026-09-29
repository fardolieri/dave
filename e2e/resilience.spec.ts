import { expect, needHooks, test } from './fixtures';

test('the call survives the server going away and coming back', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  await alice.wire.cut();
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  // Voice keeps flowing peer to peer while the server is gone.
  await expect(alice.badge('Bob')).toHaveText('direct');
  if (await alice.hasHooks()) await alice.hearing('Bob');

  alice.wire.restore();
  await alice.connected();
  await expect(alice.banner).toHaveCount(0);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
});

test('a friend whose socket drops without a goodbye is shown as lost, then recovers', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  await needHooks(alice);
  await alice.page.evaluate(() => (window as unknown as { __dave: { dropSocket: () => void } }).__dave.dropSocket());
  await alice.connected();
  await bob.connectedTo('Alice');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('a friend cut off from the server stays in the call, dimmed, as long as the connection to them works (ticket 31)', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  await alice.wire.cut();
  const lost = bob.selectedRoom.locator('li.lost');
  await expect(lost).toContainText('connection to server lost');
  // The end of the 60 s grace period is what used to close a working connection. With the hooks it is run at once, the
  // same code the timer runs; without them (or on a deployed copy older than the hook) the test waits it out.
  const canExpire = await bob.page.evaluate(() => typeof (window as unknown as { __dave?: { expireGrace?: unknown } }).__dave?.expireGrace === 'function');
  if (canExpire) expect(await bob.hook<string>('expireGrace', 'Alice')).toBe('kept');
  else { test.slow(); await bob.page.waitForTimeout(65_000); }
  await expect(lost).toContainText('Alice');
  if (await bob.hasHooks()) await bob.hearing('Alice');
  alice.wire.restore();
  // The next attempt comes after the back-off (client/room.ts): a few seconds here, 15 to 30 s after a minute away.
  await expect(alice.composer).toBeEnabled({ timeout: 35_000 });
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await expect(lost).toHaveCount(0);
  await bob.connectedTo('Alice');
});

test('a stalled connection is rebuilt and comes up again', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  // Trailing candidates of the torn-down connection can reach the new one before its description (seen with TURN on nightly;
  // Firefox logs the error only as an object handle, so the pattern cannot name addIceCandidate).
  for (const f of [alice, bob]) f.expectWarning(/signal handling failed/);
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string) => string } }).__dave.rebuild('Bob'));
  expect(r).toMatch(/^rebuilt Bob/);
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await alice.hearing('Bob');
});

test('after a stalled attempt the rebuild goes through the TURN relay, and both sides take it (ticket 22)', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  for (const f of [alice, bob]) f.expectWarning(/signal handling failed/);
  // One attempt already counted as stalled: what the watchdog does after the first 15 s without a connection.
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string, stalled: number) => string } }).__dave.rebuild('Bob', 1));
  // A local build hands out STUN only (.dev.vars carries a placeholder TURN token), so the policy stays `all` there by design.
  test.skip(r === 'rebuilt Bob, relayOnly=false', 'no TURN server behind this copy: run it against nightly');
  expect(r).toBe('rebuilt Bob, relayOnly=true');
  // Only Alice's side is relay-only, and her relay candidates alone put the pair through the TURN server: Bob reads it too.
  // A relay allocation adds round trips to the TURN server before the first check, so the wait is the watchdog's own 15 s
  // stretched, not the default.
  await expect(alice.badge('Bob')).toHaveText('via relay', { timeout: 45_000 });
  await expect(bob.badge('Alice')).toHaveText('via relay', { timeout: 45_000 });
  expect((await alice.peers()).find((p) => p.name === 'Bob')?.relayOnly).toBe(true);
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});
