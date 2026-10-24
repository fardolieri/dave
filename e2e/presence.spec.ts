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

test('the sidebar lists who is in the room on screen, and shows another room\'s people as faces beside its name, its call first', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  await crowd.open('Bob');
  const carol = await crowd.open('Carol', { rooms: [other] });
  const dave = await crowd.open('Dave', { rooms: [other] });
  const here = async () => (await alice.page.locator('aside.side ul.plist.here .nm').allInnerTexts()).map((t) => t.replace(/\s*\(you\)\s*$/, '').trim());
  const faces = () => alice.page.locator('aside.side section.room:not(.selected) .room-head .roomfaces .face').evaluateAll((els) =>
    els.map((e) => `${e.querySelector('.avatar')!.getAttribute('title')!.split(/[.,]/)[0]}${e.classList.contains('in-call') ? ' [call]' : ''}`));
  // Bob and I are here, ready to join the call; Carol and Dave are in Other, as faces beside its name, the newest first.
  await expect.poll(here).toEqual(['Bob', 'Alice']);
  await expect.poll(faces).toEqual(['Dave', 'Carol']);
  await expect(alice.page.locator('aside.side h2'), 'no list of other rooms').toHaveCount(0);
  // In Other's call, Carol comes first, in the call's ring.
  await carol.join();
  await expect.poll(faces).toEqual(['Carol [call]', 'Dave']);
  expect(await here()).toEqual(['Bob', 'Alice']);
  // Out of it, she is back as the newest.
  await carol.leave();
  await expect.poll(faces).toEqual(['Carol', 'Dave']);
});

test('on a phone, dave and ⚙ head the sidebar, my own row is only in the room, and the menu opens under the ⚙', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { viewport: { width: 390, height: 780 } });
  const page = alice.page;
  await expect(page.locator('aside.side .side-top .brand')).toHaveText('dave');
  await expect(page.locator('aside.side .side-me')).toBeHidden();
  await expect.poll(() => alice.online()).toEqual(['Alice']);
  const gear = page.locator('aside.side .side-top button.gear');
  await gear.click();
  const menu = page.locator('#side-menu');
  await expect(menu).toBeVisible();
  // Placed from the ⚙ on screen: below it (there is more room there), right edges aligned, inside the window.
  await expect.poll(async () => {
    const g = (await gear.boundingBox())!, m = (await menu.boundingBox())!;
    return m.y >= g.y + g.height && m.y - (g.y + g.height) < 20 && Math.abs(m.x + m.width - (g.x + g.width)) < 2 && m.y + m.height <= 780;
  }).toBe(true);
});

test('the room whose call I join goes to the top of the list, and stays there after a reload', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const names = () => alice.page.locator('aside.side section.room .room-title').allTextContents(); // not innerText: shown in capitals
  await expect.poll(names).toEqual(['Room', 'Other']);
  await alice.selectRoom('Other');
  await alice.join();
  await expect.poll(names).toEqual(['Other', 'Room']);
  await expect(alice.selectedRoom.locator('.room-title')).toHaveText('Other');
  await alice.page.reload();
  await alice.connected();
  await expect.poll(names).toEqual(['Other', 'Room']);
});
test('report of 2026-10-23: a friend in two of my rooms, in the call of the other one, is still listed in the room on screen', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] }); // Room on screen
  const bob = await crowd.open('Bob', { rooms: [other, crowd.room] }); // Other on screen
  await bob.join();
  const row = alice.selectedRoom.locator('ul.plist.here li', { hasText: 'Bob' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.in-call-of')).toHaveText('in Other');
  // And stays: a moment later too, once every room's presence is in.
  await alice.page.waitForTimeout(1500);
  await expect(row).toHaveCount(1);
});

test('a new name reaches everyone', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.page.locator('aside.side .side-me button.avatar').click();
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
