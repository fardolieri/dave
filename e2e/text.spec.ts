import { expect, newSecret, test } from './fixtures';

// Text chat as it works today (server relay, history per browser). The decentralized-rooms tickets change the transport
// underneath; these tests pin the behaviour friends see, so they must keep passing through that change.

test('a text reaches everyone in the room, once, with the sender name', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  await alice.say('hello from alice');
  for (const f of [alice, bob, carol]) await expect.poll(() => f.chat()).toEqual([{ from: 'Alice', text: 'hello from alice' }]);
});

test('everyone sees the same order, even for texts sent at the same moment', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await Promise.all([
    (async () => { for (let i = 1; i <= 5; i++) await alice.say(`a${i}`); })(),
    (async () => { for (let i = 1; i <= 5; i++) await bob.say(`b${i}`); })(),
  ]);
  await expect.poll(async () => (await alice.chatTexts()).length).toBe(10);
  await expect.poll(async () => (await bob.chatTexts()).length).toBe(10);
  expect(await bob.chatTexts()).toEqual(await alice.chatTexts());
  // Each sender's own texts stay in the order they were sent.
  const texts = await alice.chatTexts();
  expect(texts.filter((t) => t.startsWith('a'))).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  expect(texts.filter((t) => t.startsWith('b'))).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
});

test('text is plain: markup arrives as text and links are clickable', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.say('<img src=x onerror="window.pwned=1"> see https://example.com/a?b=c');
  await expect.poll(() => bob.chatTexts()).toEqual(['<img src=x onerror="window.pwned=1"> see https://example.com/a?b=c']);
  await expect(bob.page.locator('.chat-log a[href="https://example.com/a?b=c"]')).toHaveAttribute('rel', /noopener/);
  expect(await bob.page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test('received history survives a reload, and "Clear chat history" empties it', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.say('one');
  await bob.say('two');
  await expect.poll(() => bob.chatTexts()).toEqual(['one', 'two']);
  await bob.page.reload();
  await bob.connected();
  await expect.poll(() => bob.chatTexts()).toEqual(['one', 'two']);

  bob.page.once('dialog', (d) => void d.accept());
  await bob.page.getByRole('button', { name: 'Clear chat history' }).click();
  await expect.poll(() => bob.chatTexts()).toEqual([]);
  await bob.page.reload();
  await bob.connected();
  await expect.poll(() => bob.chatTexts()).toEqual([]);
  // Alice's copy is hers alone.
  expect(await alice.chatTexts()).toEqual(['one', 'two']);
});

test('a text in a room not on screen counts as unread and chimes; own texts never chime', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const bob = await crowd.open('Bob', { rooms: [other] });
  const cuesBefore = await alice.cues();
  await bob.say('psst');
  const unread = alice.page.locator('button.room-name', { hasText: 'Other' }).locator('.unread');
  await expect(unread).toHaveText('1');
  if (cuesBefore >= 0) await expect.poll(() => alice.cues()).toBe(cuesBefore + 1);
  await alice.selectRoom('Other');
  await expect(unread).toHaveCount(0);
  expect(await alice.chatTexts()).toEqual(['psst']);
  const bobCues = await bob.cues();
  await bob.say('mine');
  await expect.poll(() => alice.chatTexts()).toEqual(['psst', 'mine']);
  if (bobCues >= 0) expect(await bob.cues()).toBe(bobCues);
});

test('the composer refuses to send while the server is unreachable, and works again after', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.wire.cut();
  await expect(alice.composer).toBeDisabled();
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  alice.wire.restore();
  await alice.connected();
  await alice.say('back');
  await expect.poll(() => bob.chatTexts()).toEqual(['back']);
});

test('regression: the chat keeps its place when the share strip comes and goes', async ({ crowd }) => {
  // Sep 2026: the strip halving the log hid the newest line; a reader who had scrolled up was snapped to the bottom.
  const alice = await crowd.open('Alice', { engine: 'chromium' });
  const bob = await crowd.open('Bob', { viewport: { width: 1000, height: 420 } });
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  for (let i = 0; i < 14; i++) await alice.say(`filler line ${i}`);
  await expect.poll(async () => (await bob.chatTexts()).length).toBe(14);
  const log = bob.page.locator('.chat-log');
  const gap = () => log.evaluate((l) => Math.round(l.scrollHeight - l.clientHeight - l.scrollTop));
  await expect.poll(gap).toBeLessThan(8);

  await alice.startShare();
  await expect(bob.tile('Alice')).toBeVisible();
  await expect.poll(gap, { message: 'newest line still in view with the strip' }).toBeLessThan(8);

  await log.evaluate((l) => { l.scrollTop -= 60; });
  const scrolled = await gap();
  expect(scrolled).toBeGreaterThanOrEqual(52);
  await alice.say('arrives while Bob reads older lines');
  await expect(bob.page.locator('.chat-new')).toBeVisible();
  const withNew = await gap();
  expect(withNew).toBeGreaterThan(scrolled); // the reader was not moved: only the distance to the bottom grew

  await alice.stopShare();
  await expect(bob.page.locator('.share')).toHaveCount(0);
  await expect.poll(gap, { message: 'the reader stays in place when the strip goes' }).toBeGreaterThanOrEqual(withNew - 2);
  await bob.page.locator('.chat-new').click();
  await expect.poll(gap).toBeLessThan(8);
  await expect(bob.page.locator('.chat-new')).toHaveCount(0);
});
