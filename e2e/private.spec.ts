import { crc32, deflateSync } from 'node:zlib';
import { expect, newSecret, test, type Friend } from './fixtures';

/** A real PNG, `width` by `height`, all one colour, so the browser has something to decode. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
  const rows = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0; // filter: none
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// Private conversations (ADR 0011): one per friend, apart from every room, each a room of two whose secret only the two
// browsers derive, entered under keys of their own. These pin what each friend sees, what reaches Carol's browser at all,
// and what the server can tell.

/** Opens the private conversation with a friend from their row in the sidebar's lists: their card, then Message. */
async function openFromOnline(f: Friend, name: string): Promise<void> {
  await f.settledOnline(name);
  await f.page.locator('aside.side ul.plist.visitors li', { hasText: name }).first().locator('.nm').click();
  await f.page.locator('.profile .profile-message').click();
  await expect(f.page.locator('.private-head')).toContainText(name);
}

/** Opens the conversation with a friend from their row under Direct messages, folded at the bottom of the sidebar, online or not. */
async function openFromList(f: Friend, name: string): Promise<void> {
  const dms = f.page.locator('aside.side details.dms');
  await dms.evaluate((el: HTMLDetailsElement) => { el.open = true; }); // as a click on its summary, minus folding it if the app just unfolded it
  await dms.locator('li', { hasText: name }).locator('button.avatar').click();
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

/** The friends under Direct messages with private texts I have not read, as "Name (n)". */
async function threads(f: Friend): Promise<string[]> {
  return f.page.locator('aside.side details.dms li:has(.unread)').evaluateAll((els) => els.map((e) => {
    const name = (e.querySelector('.tname')?.firstChild?.textContent ?? '').trim();
    return `${name} (${e.querySelector('.unread')!.textContent!.trim()})`;
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
  await expect.poll(() => threads(bob)).toEqual([]);
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
  await expect(carol.page.locator('aside.side .unread'), 'no unread count anywhere in her sidebar').toHaveCount(0);
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
  expect(await threads(alice)).toEqual([]);
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
  // Waiting, as written, before the Room is back: sealed only once it lists Bob. Bob is offline to her meanwhile, his row
  // under the folded Direct messages still the way in.
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

test('a picture sent privately reaches only its friend, inline, and nobody else in the room is asked for it', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  const picture = png(2, 1);
  await openFromOnline(alice, 'Bob');
  await alice.attach({ name: 'secret.png', mimeType: 'image/png', buffer: picture });
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await openFromList(bob, 'Alice');
  for (const f of [alice, bob]) {
    const shown = f.page.locator('.chat.private .att-media img:not(.att-preview)');
    await expect(shown).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
  }
  // Nothing of it in the room, and Carol hears of no file: no announcement, and no file link to her.
  expect(await bob.page.locator('.chat:not(.private) .att-media').count()).toBe(0);
  expect(carol.wire.log.filter((f) => f.dir === 'down' && /^\{"t":"(private|file|link)"/.test(f.frame))).toEqual([]);
});

test('a friend\'s row opens their card beside the sidebar, the next row another card, and Message their conversation', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  await alice.settledOnline('Carol', 'Bob', 'Alice');
  const card = alice.page.locator('.profile');
  const row = (name: string) => alice.page.locator('aside.side ul.plist.visitors li', { hasText: name }).first();
  await row('Bob').locator('.nm').click();
  await expect(card.locator('.profile-name strong')).toHaveText('Bob');
  // In the chat area, clear of the sidebar, so the next row is still there to click.
  const side = (await alice.page.locator('aside.side').boundingBox())!;
  expect((await card.boundingBox())!.x).toBeGreaterThanOrEqual(side.x + side.width);
  await row('Carol').locator('.nm').click();
  await expect(card.locator('.profile-name strong')).toHaveText('Carol');
  // Her row again puts her card away; once more brings it back.
  await row('Carol').locator('.nm').click();
  await expect(card).toBeHidden();
  await row('Carol').locator('.nm').click();
  await expect(card.locator('.profile-name strong')).toHaveText('Carol');
  // Carol into the call: her row here is gone, and the card with it; her row in the call box opens it again.
  await carol.join();
  await expect(card).toBeHidden();
  await alice.selectedRoom.locator('li.prow', { hasText: 'Carol' }).locator('.nm').click();
  await expect(card.locator('.profile-name strong')).toHaveText('Carol');
  await card.locator('.profile-message').click();
  await expect(card).toBeHidden();
  await expect(alice.page.locator('.private-head')).toContainText('Carol');
});

test('the room on screen folds from its box and opens again, and a private conversation on screen folds it too', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  await crowd.open('Bob');
  await alice.settledOnline('Bob', 'Alice');
  const room = alice.page.locator('section.room').first();
  // A click on the box (its name here) folds it: Bob's row goes, his face comes beside the name; again, it opens.
  await room.locator('button.room-name').click();
  await expect(room).toHaveClass(/folded/);
  await expect(room.locator('ul.plist.here')).toHaveCount(0);
  await expect(room.locator('.roomfaces .avatar')).toHaveCount(1);
  await room.locator('button.room-name').click();
  await expect(room).not.toHaveClass(/folded/);
  // A click on Bob's name is his, not the box's: his card, and the room stays open.
  await room.locator('ul.plist.here li', { hasText: 'Bob' }).locator('.nm').click();
  await expect(alice.page.locator('.profile .profile-name strong')).toHaveText('Bob');
  await expect(room).not.toHaveClass(/folded/);
  // Our conversation on screen: the room behind it folds, and the conversation's row is the active one.
  await alice.page.locator('.profile .profile-message').click();
  await expect(room).toHaveClass(/folded/);
  await alice.composer.fill('hi');
  await alice.composer.press('Enter');
  await expect(alice.page.locator('aside.side details.dms li.on')).toContainText('Bob');
  // Back: the room is open again.
  await alice.page.locator('.private-back').click();
  await expect(room).not.toHaveClass(/folded/);
});

test('a private text not read yet is still unread after a reload', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('call me when you see this');
  await alice.composer.press('Enter');
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await bob.page.reload(); // the phone dropped the background tab
  await bob.connected();
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await expect(bob.page.locator('aside.side details.dms > summary .unread')).toHaveText('1');
  // Read, it stays read over the next reload.
  await openFromList(bob, 'Alice');
  await expect.poll(() => threads(bob)).toEqual([]);
  await bob.page.reload();
  await bob.connected();
  await expect.poll(() => threads(bob)).toEqual([]);
});

test('ADR 0011: a private text to a friend online nowhere reaches them when they come, unread', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('hi');
  await alice.composer.press('Enter');
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await openFromList(bob, 'Alice');
  await bob.page.locator('.private-back').click();
  // Bob is gone: online in none of Alice's rooms. She can still write to him.
  await bob.wire.cut();
  await expect.poll(() => alice.online()).not.toContain('Bob');
  await expect(alice.composer).toBeEnabled();
  await alice.composer.fill('for when you are back');
  await alice.composer.press('Enter');
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'hi' }, { from: 'Alice', text: 'for when you are back' }]);
  bob.wire.restore();
  await bob.connected();
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  await openFromList(bob, 'Alice');
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'hi' }, { from: 'Alice', text: 'for when you are back' }]);
});

test('ADR 0011: the server sees a room of two keys found in no other room, not who is in it', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('just us');
  await alice.composer.press('Enter');
  await expect.poll(() => threads(bob)).toEqual(['Alice (1)']);
  type Welcome = { you: { publicKey: string } };
  const keysOf = (f: Friend) => f.wire.frames<Welcome>('down', 'welcome').map((w) => w.you.publicKey);
  const aliceIs = keysOf(alice)[0]!;
  const bobIs = keysOf(bob)[0]!;
  const alicePair = keysOf(alice).find((k) => k !== aliceIs)!;
  const bobPair = keysOf(bob).find((k) => k !== bobIs)!;
  expect(alicePair, 'Alice goes by a key of her own in the room of two').toBeDefined();
  expect(bobPair).toBeDefined();
  // In the room of two, presence lists those two keys and nobody's identity; nowhere else are they listed.
  const presences = (f: Friend) => f.wire.frames<{ people: Array<{ publicKey: string }> }>('down', 'presence').map((p) => p.people.map((x) => x.publicKey));
  for (const f of [alice, bob]) {
    for (const people of presences(f)) {
      const pair = people.includes(alicePair) || people.includes(bobPair);
      if (pair) expect(people.every((k) => k === alicePair || k === bobPair), 'a room of two lists its two keys only').toBe(true);
      else expect(people.some((k) => k === alicePair || k === bobPair), 'a room lists no key of a room of two').toBe(false);
    }
    // No frame names a friend to deliver to, and the room of two's auth publishes no private text key.
    expect(f.wire.log.filter((l) => l.frame.startsWith('{"t":"private"'))).toEqual([]);
  }
  const auths = alice.wire.frames<{ publicKey: string; privateTexts?: unknown }>('up', 'auth');
  expect(auths.filter((a) => a.publicKey === alicePair).every((a) => a.privateTexts === undefined)).toBe(true);
  expect(auths.find((a) => a.publicKey === aliceIs)?.privateTexts, 'published where friends meet, to derive rooms of two from').toBeDefined();
});

test('ADR 0011: a conversation from before rooms of two is still there, its new texts after it', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await bob.settledOnline('Alice', 'Bob');
  const aliceIs = alice.wire.frames<{ you: { publicKey: string; fingerprint: string } }>('down', 'welcome')[0]!.you;
  // What Bob's browser kept of their conversation before (ADR 0007), as that app wrote it.
  await bob.page.evaluate(async (a) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dave'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const put = (k: string, v: unknown) => new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = resolve; });
    const friend = { publicKey: a.publicKey, fingerprint: a.fingerprint, name: 'Alice' };
    await put(`private:${a.publicKey}`, [{ from: friend, text: 'from before', at: Date.now() - 3600_000, id: '0a1b2c3d4e5f60718293a4b5' }]);
    await put('privateThreads', [{ friend, at: Date.now() - 3600_000 }]);
    db.close();
  }, aliceIs);
  await bob.page.reload();
  await bob.connected();
  await openFromList(bob, 'Alice');
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'from before' }]);
  await openFromOnline(alice, 'Bob');
  await alice.composer.fill('and now');
  await alice.composer.press('Enter');
  await expect.poll(() => conversation(bob)).toEqual([{ from: 'Alice', text: 'from before' }, { from: 'Alice', text: 'and now' }]);
});

// Nov 2026, review of #126: my private texts that waited to go from before rooms of two (`unsentPrivate`, left as it was)
// were taken into the room of two on every start, unless it had them waiting or in its history. Deleting the conversation
// empties its history, and the next start sent them again.
test('regression: a private text that waited from before rooms of two does not go again after the conversation is deleted', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.settledOnline('Alice', 'Bob');
  const bobIs = bob.wire.frames<{ you: { publicKey: string; fingerprint: string } }>('down', 'welcome')[0]!.you;
  // As that app wrote it: waiting to go through a room both are in, a minute ago.
  await alice.page.evaluate((b) => localStorage.setItem('dave.unsentPrivate', JSON.stringify({
    [b.room]: [{ id: '0a1b2c3d4e5f60718293a4b5', to: { publicKey: b.publicKey, fingerprint: b.fingerprint, name: 'Bob' }, text: 'waited to go', at: Date.now() - 60_000 }],
  })), { ...bobIs, room: 'roomA' });
  await alice.page.reload();
  await alice.connected();
  await openFromOnline(alice, 'Bob');
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'waited to go' }]);
  await alice.page.locator('.private-head').getByRole('button', { name: 'Delete conversation' }).click();
  await alice.page.locator('dialog.clear').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => conversation(alice)).toEqual([]);
  await alice.page.reload();
  await alice.connected();
  await openFromOnline(alice, 'Bob');
  // Written after the start: what was taken in at the start would have gone before it.
  await alice.composer.fill('only this');
  await alice.composer.press('Enter');
  await expect.poll(() => conversation(alice)).toEqual([{ from: 'Alice', text: 'only this' }]);
});
