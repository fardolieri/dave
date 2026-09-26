import { expect, needHooks, test } from './fixtures';

test('the call survives the server going away and coming back', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  // While Alice is off the server she is out of presence, so the server turns down Bob's signaling to her.
  bob.expectWarning(/dropped signal that participant is not in the call/);
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
  // Until Alice's new socket is attached she is out of presence, so the server may turn down Bob's signaling to her.
  bob.expectWarning(/dropped signal that participant is not in the call/);
  await alice.page.evaluate(() => (window as unknown as { __dave: { dropSocket: () => void } }).__dave.dropSocket());
  await alice.connected();
  await bob.connectedTo('Alice');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('a stalled connection is rebuilt and comes up again', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string) => string } }).__dave.rebuild('Bob'));
  expect(r).toMatch(/^rebuilt Bob/);
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await alice.hearing('Bob');
});
