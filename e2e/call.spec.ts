import { expect, needHooks, test } from './fixtures';

test('two friends join the call, connect directly and hear each other', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await needHooks(alice);
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});

test('a mesh of three: every pair connects, a visitor sees the call without being in it', async ({ crowd, browserName }) => {
  const [alice, bob, carol] = [await crowd.open('Alice'), await crowd.open('Bob'), await crowd.open('Carol')];
  const vera = await crowd.open('Vera');
  // Join within a moment of each other, the case that provokes offer collisions. Firefox's fake microphone does not always
  // answer three contexts asking in the same instant (a join then hangs in getUserMedia, CI 2026-09-26), so it joins in turn.
  if (browserName === 'firefox') for (const f of [alice, bob, carol]) await f.join();
  else await Promise.all([alice.join(), bob.join(), carol.join()]);
  await alice.connectedTo('Bob', 'Carol');
  await bob.connectedTo('Alice', 'Carol');
  await carol.connectedTo('Alice', 'Bob');
  await expect.poll(async () => (await vera.inCall()).sort()).toEqual(['Alice', 'Bob', 'Carol']);
  await expect.poll(() => vera.online()).toEqual(['Vera']);
  await expect(vera.selectedRoom.locator('.conn')).toHaveCount(0); // a visitor holds no call connections
});

test('mute shows for everyone; leaving removes a participant at once', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  await alice.selectedRoom.getByRole('button', { name: 'Mute' }).click();
  const aliceRow = bob.selectedRoom.locator('li.prow', { hasText: 'Alice' });
  await expect(aliceRow).toContainText('muted');
  await alice.selectedRoom.getByRole('button', { name: 'Unmute' }).click();
  await expect(aliceRow).not.toContainText('muted');
  await alice.leave();
  await expect.poll(() => bob.inCall()).toEqual(['Bob']);
  await expect.poll(() => bob.online()).toEqual(['Alice']);
});

test('a participant who rejoins is connected again', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.leave();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
});

test('Chromium and Firefox in one call connect and hear each other', async ({ crowd, browserName }) => {
  test.skip(browserName !== 'chromium', 'one mixed call is enough');
  test.skip(!process.env['CI'] && !process.env['E2E_FIREFOX'], 'needs Firefox installed: E2E_FIREFOX=1 after `pnpm exec playwright install firefox`');
  const chris = await crowd.open('Chris');
  const fiona = await crowd.open('Fiona', { engine: 'firefox' });
  await chris.join();
  await fiona.join();
  await chris.connectedTo('Fiona');
  await fiona.connectedTo('Chris');
  await needHooks(chris);
  await chris.hearing('Fiona');
  await fiona.hearing('Chris');
});

test('ticket 24: a reload rejoins the call with no click, watched shares included; after Leave a reload stays out', async ({ crowd, browserName }) => {
  const bob = await crowd.open('Bob', { engine: 'chromium' });
  const alice = await crowd.open('Alice', { autoplay: 'default' }); // the browser's real policy: a reload brings no gesture
  await bob.join();
  await alice.join();
  await alice.connectedTo('Bob');
  await bob.startShare();
  await alice.watchShare('Bob');

  await alice.page.reload();
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible();
  await alice.connectedTo('Bob');
  await expect(alice.tile('Bob')).toHaveClass(/share-live/);
  if (browserName === 'chromium') await expect(alice.page.locator('button.unblock')).toHaveCount(0); // the live microphone unlocks playback
  if (await alice.hasHooks()) await expect.poll(() => alice.receivingShareFrom('Bob')).toBe(true);

  // The sharer reloads: back in the call, the share is gone.
  await bob.page.reload();
  await bob.connected();
  await expect(bob.button('Leave')).toBeVisible();
  await expect(bob.button('Share screen')).toBeVisible();
  await expect(alice.page.locator('.share')).toHaveCount(0);

  // Leave, then reload: a visitor.
  await alice.leave();
  await alice.page.reload();
  await alice.connected();
  await expect(alice.selectedRoom.locator('button.join')).toBeVisible();
  await expect.poll(() => bob.inCall()).toEqual(['Bob']);
});

test('ticket 23: join and leave cues follow each friend\'s profile picture', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob', { picture: '🦊' });
  const carol = await crowd.open('Carol', { picture: '💡' });
  const heard = async (f: typeof alice) => { let got: string[] = []; await expect.poll(async () => (got = await f.cuesPlayed()).length, { message: `${f.name} hears a cue` }).toBeGreaterThan(0); return got; };
  await alice.join();
  await needHooks(alice);
  // Cues only play on a running AudioContext. Headless Firefox on a runner without a sound device never gets one.
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  test.skip(context !== 'running', `no running AudioContext here (${context}), so no cue can play`);
  await heard(alice); // my own join plays my own cue
  await bob.join();
  const bobJoin = await heard(alice);
  await carol.join();
  const carolJoin = await heard(alice);
  expect(carolJoin).not.toEqual(bobJoin); // another picture, another cue
  await carol.leave();
  const carolLeave = await heard(alice);
  expect(carolLeave).not.toEqual(carolJoin); // the leave is the picture's cue backwards and lower
  expect(await heard(carol)).toBeTruthy(); // Carol heard her own leave
});
