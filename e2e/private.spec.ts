import { expect, newSecret, test, type Friend } from './fixtures';

// Private conversations (ADR 0007): one per friend, apart from every room. A text travels sealed so that only the two
// friends can read it, through a room they share, and is relayed by the Room to that friend alone. These pin what each
// friend sees, and what reaches Carol's browser at all.

/** Opens the private conversation with a friend from their avatar in the Online list. */
async function openFromOnline(f: Friend, name: string): Promise<void> {
  await f.page.locator('aside.side > ul.plist li', { hasText: name }).locator('button.avatar').click();
  await expect(f.page.locator('.private-head')).toContainText(name);
}

/** Opens a conversation from the sidebar's Private list. */
async function openFromList(f: Friend, name: string): Promise<void> {
  await f.page.locator('ul.threads button.thread', { hasText: name }).click();
  await expect(f.page.locator('.private-head')).toContainText(name);
}

/** The conversation on screen: writer and text, sent ones only, a follow-on line taking the name above. */
async function conversation(f: Friend): Promise<Array<{ from: string; text: string }>> {
  return f.page.locator('.chat.private .msg:not(.msg-sys)').evaluateAll((els) => {
    let from = '';
    return els.flatMap((e) => {
      const own = e.querySelector('.msg-from');
      if (own) from = (own.firstChild?.textContent ?? '').trim();
      return e.classList.contains('msg-pending') ? [] : [{ from, text: (e.querySelector('.msg-text') as HTMLElement | null)?.innerText.trim() ?? '' }];
    });
  });
}

/** The sidebar's Private list: names, with the unread count where there is one. */
async function threads(f: Friend): Promise<string[]> {
  return f.page.locator('ul.threads button.thread').evaluateAll((els) => els.map((e) => {
    const name = e.querySelector('.tname')?.textContent?.trim() ?? '';
    const unread = e.querySelector('.unread')?.textContent?.trim();
    return unread ? `${name} (${unread})` : name;
  }));
}

test('a private text reaches only its friend, in a conversation of its own, and an answer goes back the same way', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('just between us');
  await alice.composer.press('Enter');
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'just between us' }]);
  // Bob reads the room; the conversation shows up in his list, unread, and never in the room's chat.
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  expect(await bob.chatTexts()).toEqual([]);
  await openFromList(bob, 'Alice');
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'just between us' }]);
  await expect.poll(() => threads(bob)).toEqual(['Alice']);
  await bob.composer.fill('got it');
  await bob.composer.press('Enter');
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'just between us' }, { from: 'Bob', text: 'got it' }]);

  // Back to the room: a draft written privately goes with the conversation, so the next Enter cannot send it to the room.
  await alice.composer.fill('a draft for Bob only');
  await alice.page.locator('.private-back').click();
  await expect(alice.page.locator('.private-head')).toHaveCount(0);
  await expect(alice.composer).toHaveValue('');
  await alice.say('hello everyone');
  await expect.poll(() => carol.chatTexts()).toEqual(['hello everyone']);
  expect(await threads(carol)).toEqual([]);
  expect(carol.wire.log.filter((f) => f.dir === 'down' && f.frame.startsWith('{"t":"private"'))).toEqual([]);
  // What the Room relayed holds neither text in the clear.
  for (const f of [...alice.wire.log, ...bob.wire.log]) expect(f.frame).not.toMatch(/between us|got it/);
});

test('two friends in the same two rooms have one conversation, whichever room each has on screen', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const bob = await crowd.open('Bob', { rooms: [other, crowd.room] });
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('one');
  await alice.composer.press('Enter');
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await openFromList(bob, 'Alice');
  await bob.composer.fill('two');
  await bob.composer.press('Enter');
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'one' }, { from: 'Bob', text: 'two' }]);
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'one' }, { from: 'Bob', text: 'two' }]);
  expect(await threads(alice)).toEqual(['Bob']);
  // The head says where Bob is: in both rooms.
  await expect(alice.page.locator('.private-where')).toContainText(/Room.*Other|Other.*Room/);
});

test('a private conversation is still there after a reload', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('still ours');
  await alice.composer.press('Enter');
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  // Kept before the reload: the list and the conversation are written as the text arrives.
  await expect.poll(() => bob.page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dave'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const store = db.transaction('kv', 'readonly').objectStore('kv');
      const get = (k: string) => new Promise<unknown>((resolve) => { const r = store.get(k); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined); });
      const list = (await get('privateThreads')) as unknown[] | undefined;
      return list?.length ?? 0;
    } finally { db.close(); }
  })).toBe(1);
  await bob.page.reload();
  await bob.connected();
  await openFromList(bob, 'Alice');
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'still ours' }]);
});

test('a private text written while the server is away survives a reload, and reaches its friend once it is back', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await openFromOnline(alice, 'Bob');
  await alice.wire.cut();
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  await alice.composer.fill('kept for you');
  await alice.composer.press('Enter');
  await expect(alice.page.locator('.chat.private .msg-pending .msg-text')).toHaveText(['kept for you']);
  await alice.page.reload();
  // Waiting, as written, before the Room is back: sealed only once it lists Bob.
  await openFromList(alice, 'Bob');
  await expect(alice.page.locator('.chat.private .msg-pending .msg-text')).toHaveText(['kept for you']);
  alice.wire.restore();
  await alice.connected();
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await openFromList(bob, 'Alice');
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'kept for you' }]);
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'kept for you' }]);
  await expect(alice.page.locator('.chat .msg-pending')).toHaveCount(0);
});
