import { expect, test, type Friend } from '../fixtures';

// The tour of the main screens filmed for every pull request that changes the client (.github/workflows/receipts.yml).
// Not part of the suite: it asserts only what it needs to move on, and pauses so a person watching the video can follow.
// Run by hand with: pnpm exec playwright test -c playwright.receipts.config.ts
//
// To film the change a pull request makes, tag a test `@receipt`, here or anywhere in e2e/: the first friend it opens is filmed.

/** A pause for whoever watches the video; never a wait for the app. */
const beat = (f: Friend, ms = 1500) => f.page.waitForTimeout(ms);

test('tour: chat, invite, a call with a screen share, audio settings', { tag: '@receipt' }, async ({ crowd }) => {
  const alice = await crowd.open('Alice'); // the one filmed
  const bob = await crowd.open('Bob', { picture: '🦊' });
  const carol = await crowd.open('Carol');
  await beat(alice);

  await bob.say('anyone around?');
  await alice.say('here, Carol too');
  await carol.say('👋');
  await beat(alice);

  const invite = alice.selectedRoom.getByRole('button', { name: 'invite', exact: true });
  await invite.click();
  await expect(alice.page.locator('.panel.invite')).toBeVisible();
  await beat(alice, 2500);
  await invite.click();

  for (const f of [alice, bob, carol]) await f.join();
  await alice.connectedTo('Bob', 'Carol');
  await beat(alice);

  await bob.startShare();
  await alice.watchShare('Bob');
  await beat(alice, 3000);

  const audio = alice.selectedRoom.getByTitle('Audio settings');
  await audio.click();
  await beat(alice, 2500);
  await audio.click();

  await bob.stopShare();
  await alice.leave();
  await beat(alice);
});
