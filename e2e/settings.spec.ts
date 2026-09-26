import { expect, needHooks, test } from './fixtures';

// Audio settings, volumes, the problem report, and the phone layout.

test('turning audio processing off warns, and the change reaches the microphone track', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  await alice.join();
  await alice.selectedRoom.getByTitle('Audio settings').click();
  const panel = alice.page.locator('.panel');
  await expect(panel.locator('.hint', { hasText: 'usually makes you sound worse' })).toBeVisible();
  await panel.getByLabel('Noise suppression').uncheck();
  await expect(panel.locator('.warn')).toContainText('Audio processing is off');
  await needHooks(alice);
  await expect.poll(async () => (await alice.hook<{ settings: { noiseSuppression: boolean } }>('audio')).settings.noiseSuppression).toBe(false);
  await panel.getByLabel('Noise suppression').check();
  await expect(panel.locator('.warn')).toHaveCount(0);
});

test('a friend\'s volume and the master volume multiply, and survive a reload', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  const gainOfBob = async () => (await alice.hook<{ peers: Array<{ name: string; voiceGain: number | null }> }>('volumes')).peers.find((p) => p.name === 'Bob')?.voiceGain;

  await alice.selectedRoom.locator('li.prow', { hasText: 'Bob' }).locator('button.vol').click();
  await alice.selectedRoom.locator('.volrow input[type=range]').fill('150');
  await expect.poll(gainOfBob).toBeCloseTo(1.5);
  await expect(alice.selectedRoom.locator('li.prow', { hasText: 'Bob' }).locator('button.vol')).toContainText('150%');

  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel label.mvol input[type=range]').fill('50');
  await expect.poll(gainOfBob).toBeCloseTo(0.75);

  await alice.page.reload();
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible(); // a reload rejoins the call by itself (ticket 24)
  await alice.connectedTo('Bob');
  await expect.poll(gainOfBob).toBeCloseTo(0.75);
});

test('a problem report is sent to the error log, with the friend told so', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { plainUserAgent: true });
  await alice.page.getByRole('button', { name: 'Report a problem' }).click();
  const dialog = alice.page.locator('dialog.report');
  await dialog.locator('select').selectOption('text');
  await dialog.getByLabel(/Blocking/).check();
  await dialog.locator('textarea').fill('automated test report, please ignore');
  const before = alice.posthog.length;
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.locator('.ok')).toContainText('Sent, thank you');
  await expect.poll(() => alice.posthog.length, { message: 'the report went out (to the local stand-in for PostHog)' }).toBeGreaterThan(before);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).not.toBeVisible();
});

test('phone width: one column, the composer pinned to the bottom of the screen and usable', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', { viewport: { width: 390, height: 780 } });
  for (let i = 0; i < 30; i++) await alice.say(`line ${i}`);
  await expect.poll(async () => (await bob.chatTexts()).length).toBe(30);
  const box = await bob.composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(780);
  expect(box!.y).toBeGreaterThan(780 - 120);
  expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390); // no sideways scrolling
  await bob.say('from the phone');
  await expect.poll(() => alice.chatTexts()).toContain('from the phone');
});
