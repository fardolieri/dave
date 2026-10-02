import { expect, newSecret, test } from './fixtures';

// Text chat as it works today (server relay, history per browser). These tests pin the behaviour friends see, so they
// must keep passing through any change to the transport underneath.

test('a text reaches everyone in the room, once, with the sender name', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  await alice.say('hello from alice');
  for (const f of [alice, bob, carol]) await expect.poll(() => f.chat()).toEqual([{ from: 'Alice', text: 'hello from alice' }]);
});

test('texts in a row from one writer go under one name', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.say('one');
  await alice.say('two');
  await expect.poll(() => bob.chatTexts()).toEqual(['one', 'two']);
  await bob.say('three');
  await alice.say('four');
  await expect.poll(() => bob.chatTexts()).toEqual(['one', 'two', 'three', 'four']);
  await expect(bob.page.locator('.chat-log .msg-from')).toHaveCount(3); // Alice, Bob, Alice
  expect(await bob.chat()).toEqual([
    { from: 'Alice', text: 'one' }, { from: 'Alice', text: 'two' }, { from: 'Bob', text: 'three' }, { from: 'Alice', text: 'four' },
  ]);
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

test('leaving a room forgets its history: the link brings the room back, not the lines', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', { rooms: [crowd.room, other] });
  await alice.say('before');
  await expect.poll(() => bob.chatTexts()).toEqual(['before']);
  bob.page.once('dialog', (d) => void d.accept());
  await bob.page.getByRole('button', { name: `Leave ${crowd.room.name}` }).click();
  await expect(bob.page.locator('button.room-name', { hasText: crowd.room.name })).toHaveCount(0);
  await bob.page.goto(`/#${crowd.room.secret}/${encodeURIComponent(crowd.room.name)}`);
  await bob.connected();
  await expect(bob.selectedRoom.locator('.room-title')).toHaveText(crowd.room.name);
  // A live line after the rejoin: the history, loaded first, would have come before it.
  await alice.say('after');
  await expect.poll(() => bob.chatTexts()).toEqual(['after']);
});

test('texts from more than 18 h before the room came on screen wait behind a button, folded again each time it does', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', { rooms: [crowd.room, other] });
  await alice.say('yesterday one');
  await alice.say('yesterday two');
  await alice.say('this morning');
  await expect.poll(() => bob.chatTexts()).toEqual(['yesterday one', 'yesterday two', 'this morning']);
  // Bob's own copy, as if the first two had come in 19 h ago and the third 17 h ago.
  await bob.page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dave'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const store = () => db.transaction('kv', 'readwrite').objectStore('kv');
    const keys = await new Promise<IDBValidKey[]>((resolve) => { const r = store().getAllKeys(); r.onsuccess = () => resolve(r.result); });
    for (const key of keys.filter((k) => String(k).startsWith('history:'))) {
      const list = await new Promise<Array<{ text: string; at: number }>>((resolve) => { const r = store().get(key); r.onsuccess = () => resolve(r.result); });
      const aged = list.map((m) => ({ ...m, at: Date.now() - (m.text.startsWith('yesterday') ? 19 : 17) * 3600_000 }));
      await new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(aged, key); tx.oncomplete = resolve; });
    }
    db.close();
  });
  await bob.page.reload();
  await bob.connected();
  const older = bob.page.locator('.chat-older');
  await expect(older).toHaveText('Show older messages');
  await expect.poll(() => bob.chat()).toEqual([{ from: 'Alice', text: 'this morning' }]); // the first line shown has its name
  await alice.say('now');
  await expect.poll(() => bob.chatTexts()).toEqual(['this morning', 'now']);

  await older.click();
  await expect(older).toHaveCount(0);
  expect(await bob.chatTexts()).toEqual(['yesterday one', 'yesterday two', 'this morning', 'now']);

  await bob.selectRoom('Other');
  await bob.selectRoom(crowd.room.name);
  await expect(older).toHaveText('Show older messages');
  expect(await bob.chatTexts()).toEqual(['this morning', 'now']);
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
  // Enough to overflow the log even without the strip; one writer's lines sit close together under one name.
  for (let i = 0; i < 24; i++) await alice.say(`filler line ${i}`);
  await expect.poll(async () => (await bob.chatTexts()).length).toBe(24);
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
