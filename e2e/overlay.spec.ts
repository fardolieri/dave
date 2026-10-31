import { expect, needHooks, openRoomMenu, test } from './fixtures';

type Overlay = { room: string; lines: string[]; pip: boolean } | null;

test('the overlay shows the room\'s friends in picture-in-picture, and follows who joins, speaks and mutes', async ({ crowd, browserName }) => {
  const alice = await crowd.open('Alice');
  await needHooks(alice);
  const bob = await crowd.open('Bob', { picture: '🦎' });
  const { page } = alice;
  const menu = page.locator('.room-menu:popover-open');
  await openRoomMenu(page);
  // Only where a page can ask for picture-in-picture of a video: elsewhere the menu has no Overlay
  const supported = await page.evaluate(() => (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true && 'requestPictureInPicture' in HTMLVideoElement.prototype);
  // Chromium has it: a test that skipped there would check nothing
  expect(supported || browserName !== 'chromium').toBe(true);
  if (!supported) {
    await expect(menu.getByRole('button', { name: /overlay/i })).toHaveCount(0);
    return;
  }
  await menu.getByRole('button', { name: 'Overlay', exact: true }).click();
  const overlay = () => page.evaluate(() => (window as unknown as { __daveOverlay: () => Overlay }).__daveOverlay());
  // What it says, the speaking rings left out: the fake microphone beeps on and off
  const lines = async () => (await overlay())?.lines.map((l) => l.replace(' (speaking)', '')) ?? null;
  await expect.poll(async () => (await overlay())?.pip).toBe(true);
  await expect.poll(lines).toEqual(['Room', '🦎 Bob', 'A Alice (you)', 'nobody in the call']);
  // It follows the room as it changes
  await bob.join();
  await expect.poll(lines).toEqual(['Room', 'A Alice (you)', 'call:', '🦎 Bob']);
  await alice.join();
  await bob.connectedTo('Alice');
  await expect.poll(lines).toEqual(['Room', 'call:', 'A Alice (you)', '🦎 Bob']);
  // Who speaks has the ring, as on the page: Alice, her voice gate all the way open (the fake microphone's beep is no voice
  // to noise removal), until she mutes
  const own = async () => (await overlay())?.lines.find((l) => l.includes('Alice'));
  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel').getByLabel('Voice gate').fill('0');
  // Headless Firefox on a runner without a sound device never gets a running AudioContext (settings.spec.ts): nobody
  // speaks there, on the page either
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  if (context === 'running') await expect.poll(own).toBe('A (speaking) Alice (you)');
  else test.info().annotations.push({ type: 'not checked', description: `the speaking ring: no running AudioContext here (${context})` });
  await alice.selectedRoom.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(own).toBe('A Alice (you) [muted]');
  // It follows the room folded too
  await page.locator('section.room.selected .room-head button.room-name').click();
  await expect(page.locator('section.room.selected')).toHaveClass(/folded/);
  await bob.selectedRoom.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(lines).toEqual(['Room', 'call:', 'A Alice (you) [muted]', '🦎 Bob [muted]']);
  // Closed from the menu, the window goes with it
  await openRoomMenu(page);
  await menu.getByRole('button', { name: 'Close overlay', exact: true }).click();
  await expect.poll(overlay).toBeNull();
  await expect.poll(() => page.evaluate(() => (document as Document & { pictureInPictureElement?: Element | null }).pictureInPictureElement ?? null)).toBeNull();
  await openRoomMenu(page);
  await expect(menu.getByRole('button', { name: 'Overlay', exact: true })).toBeVisible();
});
