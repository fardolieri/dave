import { reactionCue } from '../src/core/cue';
import { expect, newSecret, test, type Friend } from './fixtures';

// Ticket 55: reactions float up over the room for everyone, with the sender's name, and pop out beside their avatar.

/** The reactions floating over the room on screen right now, as "emoji name". */
const floating = (f: Friend) => f.page.locator('.app > .reactions .reaction').evaluateAll((els) => els.map((e) => `${e.querySelector('.re')?.textContent} ${e.querySelector('.rn')?.textContent}`.trim()));
const plink = (emoji: string) => `sine ${Math.round(reactionCue(emoji).notes[0]!.freq)}`;

test('ticket 55: a reaction floats up for everyone in the room, with its sound in the call and none outside it', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { picture: '🦊' });
  const bob = await crowd.open('Bob', { picture: '🐸' });
  const vera = await crowd.open('Vera');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  // Nothing to react with from outside the call
  await expect(vera.page.locator('.reacts')).toHaveCount(0);

  await Promise.all([alice, bob, vera].map((f) => f.cuesPlayed())); // the joins' cues are not what this test listens for
  await alice.button('React 🔥').click();
  // All at once and polled closely: the float and the pop are gone 3.2 s after they came, and one check after another
  // with the poll's backoff could come after that on a slow runner
  await Promise.all([
    expect.poll(() => floating(bob), { message: 'Bob sees Alice\'s 🔥', intervals: [50] }).toContain('🔥 Alice'),
    expect(bob.selectedRoom.locator('li.prow', { hasText: 'Alice' }).locator('.avatar-react')).toHaveText('🔥'),
    expect.poll(() => floating(alice), { message: 'Alice sees her own, as "you"', intervals: [50] }).toContain('🔥 you'),
    expect.poll(() => floating(vera), { message: 'Vera, reading the room, sees it too', intervals: [50] }).toContain('🔥 Alice'),
  ]);

  const context = await bob.page.evaluate(() => typeof AudioContext);
  if (context === 'function') {
    // A cue sounds only where an AudioContext runs; where one does, the plink is the emoji's own note.
    const bobHeard = await bob.cuesPlayed(), veraHeard = await vera.cuesPlayed();
    if (bobHeard.length > 0) expect(bobHeard).toContain(plink('🔥'));
    expect(veraHeard, 'no plink outside the call').not.toContain(plink('🔥'));
  }

  // Any emoji from the picker, which stays open for more
  await bob.selectedRoom.getByRole('button', { name: 'React with any emoji' }).click();
  const search = bob.page.locator('#react-emoji .emoji-search');
  await search.fill('taco');
  await search.press('Enter');
  await expect.poll(() => floating(alice), { message: 'Alice sees Bob\'s 🌮' }).toContain('🌮 Bob');
  await expect(bob.page.locator('#react-emoji')).toBeVisible();
  await bob.page.keyboard.press('Escape');

  // A reaction is gone after its float, and never lands in the chat
  await expect.poll(() => floating(alice), { timeout: 8000 }).toEqual([]);
  expect(await alice.chatTexts()).toEqual([]);
});

test('ticket 55: hammering a reaction is held back in the browser, never refused by the server or said in the chat', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  // Forty taps inside one task, quicker than any finger
  await alice.button('React 🔥').evaluate((b: HTMLButtonElement) => { for (let i = 0; i < 40; i++) b.click(); });
  const sent = () => alice.wire.frames('up', 'react').length;
  await expect.poll(async () => { const n = (await floating(bob)).length; return n > 0 && n === sent(); }, { message: 'Bob sees every reaction Alice sent' }).toBe(true);
  expect(sent(), 'the browser sends a burst, not every tap').toBeLessThan(40);
  expect(alice.wire.frames<{ ref?: string }>('down', 'error').filter((e) => e.ref === 'react'), 'the server refused none').toEqual([]);
  expect(await alice.page.locator('.msg-sys').count(), 'no "Dropped" line').toBe(0);
});

test('ticket 55: a reaction floats over the room I am reading, while my call is in another', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const vera = await crowd.open('Vera', { rooms: [crowd.room, other] });
  await vera.selectRoom('Other');
  await vera.join();
  await alice.join();
  await bob.join();
  await vera.selectRoom('Room');
  await alice.button('React 🔥').click();
  // The pop beside Alice's avatar in the room Vera reads, and the float over it, not only over the call she is in
  await expect(vera.selectedRoom.locator('li.prow', { hasText: 'Alice' }).locator('.avatar-react')).toHaveText('🔥');
  await expect.poll(() => floating(vera), { message: 'Vera, reading Room from Other\'s call, sees Alice\'s 🔥', intervals: [50] }).toContain('🔥 Alice');
});

test('ticket 55: on a phone, the fullscreen bar with its reactions keeps every button on the screen', async ({ crowd, browserName }) => {
  test.skip(browserName !== 'chromium', 'headless Firefox does not grant fullscreen');
  const phone = { width: 360, height: 740 };
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', { viewport: phone });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await alice.startShare();
  await bob.watchShare('Alice');
  await bob.tile('Alice').click();
  await expect.poll(() => bob.page.evaluate(() => document.fullscreenElement?.classList.contains('share') ?? false)).toBe(true);
  const tile = bob.tile('Alice');
  for (const b of [tile.locator('button.fs'), tile.locator('.share-vol'), tile.getByRole('button', { name: 'React 👏' })]) {
    const box = (await b.boundingBox())!;
    expect(box.x + box.width, `${await b.evaluate((e) => e.className || e.textContent)} inside the screen`).toBeLessThanOrEqual(phone.width);
  }
});
