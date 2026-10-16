import { expect, newSecret, test } from './fixtures';

test('first visit through an invite link: pick a name, land in the room, the secret leaves the address bar', async ({ crowd }) => {
  const secret = newSecret();
  const vicky = await crowd.open('Vicky', { rooms: [], name: null, connect: false });
  await vicky.page.goto(`/#${secret}/Friends`);
  await vicky.page.getByPlaceholder('Your name').fill('Vicky');
  await vicky.page.getByRole('button', { name: 'Continue' }).click();
  await vicky.connected();
  await expect(vicky.selectedRoom.locator('.room-title')).toHaveText('Friends');
  expect(vicky.page.url()).not.toContain(secret);
  // A second friend with the same link lands in the same room.
  const walt = await crowd.open('Walt', { rooms: [{ secret, name: 'Friends' }] });
  await expect.poll(() => walt.online()).toEqual(['Vicky', 'Walt']);
});

test('presence lists everyone online and drops a friend who closes the page', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  // Friends in the order they came, the newest on top; you last.
  await expect.poll(() => alice.online()).toEqual(['Carol', 'Bob', 'Alice']);
  await carol.close();
  await expect.poll(() => alice.online()).toEqual(['Bob', 'Alice']);
  await expect.poll(() => bob.online()).toEqual(['Alice', 'Bob']);
});

test('rooms are separate: presence and text do not cross', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', { rooms: [other] });
  await alice.say('only here');
  await bob.say('only there');
  await expect.poll(() => alice.chatTexts()).toEqual(['only here']);
  await expect.poll(() => bob.chatTexts()).toEqual(['only there']);
  expect(await alice.online()).toEqual(['Alice']);
});

test('a new name reaches everyone', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.page.locator('aside.side > ul.plist li', { hasText: '(you)' }).locator('button.avatar').click();
  await alice.page.locator('.profile button.edit').click();
  await alice.page.locator('.profile-edit input').fill('Alicia');
  await alice.page.locator('.profile-edit button.on').click();
  await expect.poll(() => bob.online()).toContain('Alicia');
});

test('a new name and picture chosen during the handshake reach everyone', async ({ crowd }) => {
  // Review on 10-10 (quality ticket 10): a rename made after the auth went out, before the welcome, was lost. The auth
  // carried the old name, and the rename itself was written to no socket.
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  // The new name typed, not saved yet. In CI a click on the call list or its controls waited out the whole handshake,
  // which the app gives up after 10 s: only the last two clicks, inside the open card, happen during it.
  await alice.selectedRoom.locator('li.prow', { hasText: '(you)' }).locator('button.avatar').click();
  await alice.page.locator('.profile button.edit').click();
  await alice.page.locator('.profile-edit input').fill('Alicia');
  // Alice's next welcome is held back: her socket is open, the Room has her in with the auth she sent, she waits.
  const held: { welcome?: () => void } = {};
  alice.wire.down = (frame, pass) => {
    if (!frame.includes('"t":"welcome"')) return frame;
    alice.wire.down = null;
    held.welcome = () => pass(frame);
    return null;
  };
  await alice.wire.cut();
  alice.wire.restore();
  await expect.poll(() => held.welcome !== undefined, { message: 'Alice\'s socket is back and its welcome held' }).toBe(true);
  const auths = alice.wire.frames('up', 'auth');
  expect(auths.at(-1)).toMatchObject({ name: 'Alice', picture: '😀' });

  await alice.page.locator('.profile-edit button.on').click();
  await alice.page.locator('.profile').getByRole('button', { name: 'remove the picture' }).click();
  held.welcome!();
  await alice.connected();
  // Not the app giving up on the handshake and trying again, with an auth that carries the new name.
  expect(alice.wire.frames('up', 'auth'), 'the welcome held is the one let in').toHaveLength(auths.length);

  // In the call list, where Bob sees her.
  const row = bob.selectedRoom.locator('li.prow', { hasText: 'Alicia' });
  await expect(row, 'Bob sees the new name').toHaveCount(1);
  await expect(row.locator('button.avatar'), 'Bob sees the picture gone').toHaveText('A');
});

test('ticket 25: one tab at a time; the first keeps working, a second waits, takes over on request or when the first closes', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');

  const second = await alice.context.newPage();
  alice.watch(second);
  await second.goto('/');
  const notice = (p: typeof second) => p.locator('main.notice h2', { hasText: 'already open in another tab' });
  await expect(notice(second)).toBeVisible();
  await expect(second.locator('aside.side')).toHaveCount(0); // no workspace, no socket
  await expect(alice.button('Leave')).toBeVisible(); // the first tab is still in the call
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);

  // A reload of the first tab keeps the app there (and rejoins), though the second is ahead in the lock queue.
  await alice.page.reload();
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible();
  await expect(notice(second)).toBeVisible();
  await alice.connectedTo('Bob');

  // "Use it here instead": the first tab steps back and leaves the call cleanly.
  await second.getByRole('button', { name: 'Use it here instead' }).click();
  await expect(second.locator('.chat-field > input')).toBeEnabled();
  await expect(notice(alice.page)).toBeVisible();
  await expect.poll(() => bob.inCall()).toEqual(['Bob']);
  await expect.poll(() => bob.online()).toEqual(['Alice']); // Bob is in the call, so only Alice is listed as online

  // The tab in charge closes: the waiting one takes over by itself, and does not pull Alice back into a call.
  await second.locator('section.room.selected button.join').click();
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await second.close();
  await alice.connected();
  await expect(alice.selectedRoom.locator('button.join')).toBeVisible();
});
