import { expect, needHooks, test, type Friend } from './fixtures';

// Screen shares. The sharer is always Chromium (its fake screen capture needs no picker); viewers run in the project's engine,
// so the Firefox project covers Firefox watching a Chromium share.

/** Opens the named friends and puts them all in the call. The first `sharers` of them run in Chromium. */
async function callOf<N extends string[]>(crowd: { open: (n: string, o?: object) => Promise<Friend> }, names: [...N], sharers = 1): Promise<{ [K in keyof N]: Friend }> {
  const friends: Friend[] = [];
  for (const [i, n] of names.entries()) friends.push(await crowd.open(n, i < sharers ? { engine: 'chromium' } : {}));
  for (const f of friends) await f.join();
  for (const f of friends) await f.connectedTo(...names.filter((n) => n !== f.name));
  return friends as { [K in keyof N]: Friend };
}

test('a share flows only to a viewer who asked for it, and stops when they stop watching', async ({ crowd }) => {
  const [alice, bob, carol] = await callOf(crowd, ['Alice', 'Bob', 'Carol']);
  await alice.startShare();
  await expect(bob.tile('Alice')).toHaveClass(/share-closed/);
  await expect(bob.tile('Alice')).toContainText('Click to watch');
  await bob.watchShare('Alice');
  await needHooks(bob);
  await expect.poll(() => bob.receivingShareFrom('Alice')).toBe(true);
  expect(await carol.videoBytesFrom('Alice')).toBe(0); // Carol never subscribed: the sharer sends her nothing

  await bob.tile('Alice').getByRole('button', { name: 'Stop watching' }).click();
  await expect(bob.tile('Alice')).toHaveClass(/share-closed/);
  await expect.poll(() => bob.receivingShareFrom('Alice'), { message: 'share video stops flowing' }).toBe(false);

  await alice.stopShare();
  await expect(bob.page.locator('.share')).toHaveCount(0);
});

test('regression: a share stopped and started again goes live for its viewer, not stuck on Opening', async ({ crowd }) => {
  // Problem report of Oct 3: the remote track can stay unmuted when the sharer only stops sending, so the second share
  // never fired the unmute that marks a tile live, and its frames played behind "Opening…".
  const [alice, bob] = await callOf(crowd, ['Alice', 'Bob']);
  await alice.startShare();
  await bob.watchShare('Alice');
  await expect(bob.tile('Alice')).toHaveClass(/share-live/);
  await alice.stopShare();
  await expect(bob.page.locator('.share')).toHaveCount(0);

  await alice.startShare();
  await bob.watchShare('Alice');
  await expect(bob.tile('Alice')).toHaveClass(/share-live/);
  await expect(bob.tile('Alice').locator('video')).toBeVisible();
});

test('two sharers at once: a viewer watches both and dropping one leaves the other flowing', async ({ crowd }) => {
  const [alice, bob, carol] = await callOf(crowd, ['Alice', 'Bob', 'Carol'], 2);
  await alice.startShare();
  await bob.startShare();
  await carol.watchShare('Alice');
  await carol.watchShare('Bob');
  await needHooks(carol);
  await carol.tile('Alice').getByRole('button', { name: 'Stop watching' }).click();
  await expect.poll(() => carol.receivingShareFrom('Alice')).toBe(false);
  expect(await carol.receivingShareFrom('Bob')).toBe(true);
});

test('fullscreen: a click on a running tile enters it, another leaves it, the share ending leaves it', async ({ crowd, browserName }) => {
  test.skip(browserName !== 'chromium', 'headless Firefox does not grant fullscreen');
  const [alice, bob] = await callOf(crowd, ['Alice', 'Bob']);
  await alice.startShare();
  await bob.watchShare('Alice');
  const fullscreen = () => bob.page.evaluate(() => document.fullscreenElement?.classList.contains('share') ?? false);
  await bob.tile('Alice').click();
  await expect.poll(fullscreen).toBe(true);
  await bob.tile('Alice').click();
  await expect.poll(fullscreen).toBe(false);
  await expect(bob.tile('Alice')).toHaveClass(/share-live/); // still watching
  await bob.tile('Alice').click();
  await expect.poll(fullscreen).toBe(true);
  await alice.stopShare();
  await expect.poll(fullscreen).toBe(false);
});

test('a watched share\'s sound is set from its tile without going fullscreen, and leaves the voice alone', async ({ crowd }) => {
  const [alice, bob] = await callOf(crowd, ['Alice', 'Bob']);
  await alice.startShare();
  await bob.watchShare('Alice');
  await needHooks(bob);
  const ofAlice = async () => (await bob.hook<{ peers: Array<{ name: string; view: number; shareView: number }> }>('volumes')).peers.find((p) => p.name === 'Alice');

  // The slider opens from its button, so a stray tap on the tile's bar cannot set it.
  await expect(bob.tile('Alice').locator('.share-vol')).toHaveCount(0);
  await bob.tile('Alice').locator('button.share-vol-btn').click();
  await bob.tile('Alice').locator('.share-vol input[type=range]').fill('40');
  await expect.poll(async () => (await ofAlice())?.shareView).toBeCloseTo(0.4);
  await expect(bob.tile('Alice').locator('button.share-vol-btn')).toContainText('40%');
  expect((await ofAlice())?.view).toBe(1);
  expect(await bob.page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(bob.tile('Alice')).toHaveClass(/share-live/);
  await expect(alice.page.locator('.share :is(.share-vol, .share-vol-btn)')).toHaveCount(0); // my own share plays nothing for me
});

test('regression: a friend\'s voice volume and their share\'s volume are set apart, neither scales the other', async ({ crowd }) => {
  // Oct 2026, Daniel: a friend turned down to 5 % made their share play at 5 % too, while its slider said 100 %.
  const [alice, bob] = await callOf(crowd, ['Alice', 'Bob']);
  await alice.startShare();
  await bob.watchShare('Alice');
  await needHooks(bob);
  const round = (g: number | null | undefined) => (g == null ? null : Math.round(g * 1000) / 1000);
  const gains = async () => {
    const p = (await bob.hook<{ peers: Array<{ name: string; voiceGain: number | null; shareGain: number | null }> }>('volumes')).peers.find((x) => x.name === 'Alice');
    return { voice: round(p?.voiceGain), share: round(p?.shareGain) };
  };

  await bob.selectedRoom.locator('li.prow', { hasText: 'Alice' }).locator('button.vol').click();
  await bob.selectedRoom.locator('.volrow input[type=range]').fill('5');
  await expect.poll(gains).toEqual({ voice: 0.05, share: 1 });
  await bob.tile('Alice').locator('button.share-vol-btn').click();
  await bob.tile('Alice').locator('.share-vol input[type=range]').fill('150');
  await expect.poll(gains).toEqual({ voice: 0.05, share: 1.5 });
});

test('regression: presence changes neither recreate a watched tile nor end its fullscreen', async ({ crowd, browserName }) => {
  // Sep 2026, production: someone leaving, joining or muting recreated every share tile and threw the viewer out of fullscreen.
  test.skip(browserName !== 'chromium', 'headless Firefox does not grant fullscreen');
  const [sam, vic, tom] = await callOf(crowd, ['Sam', 'Vic', 'Tom']);
  await sam.startShare();
  await vic.watchShare('Sam');
  await vic.tile('Sam').evaluate((t) => { t.dataset['mark'] = 'original'; });
  await vic.tile('Sam').click();
  const state = () => vic.page.evaluate(() => ({ fullscreen: document.fullscreenElement !== null, same: (document.querySelector('.share[data-mark="original"]') !== null) }));
  await expect.poll(state).toEqual({ fullscreen: true, same: true });
  await tom.leave();
  await expect.poll(() => vic.inCall()).toEqual(['Vic', 'Sam']);
  expect(await state()).toEqual({ fullscreen: true, same: true });
  await tom.join();
  await vic.connectedTo('Tom');
  expect(await state()).toEqual({ fullscreen: true, same: true });
  await tom.button('Mute').click();
  await expect(vic.selectedRoom.locator('li.prow', { hasText: 'Tom' })).toContainText('muted');
  expect(await state()).toEqual({ fullscreen: true, same: true });
});

test('regression: a Watch click while the socket is down is asked for again after the reconnect', async ({ crowd }) => {
  // Sep 2026, production: the click was dropped for good and the tile promised a picture nobody had asked for.
  const [sam, vic] = await callOf(crowd, ['Sam', 'Vic']);
  await needHooks(vic);
  await sam.startShare();
  await expect(vic.tile('Sam')).toContainText('Click to watch');
  await vic.wire.cut();
  await expect(vic.away).toBeVisible();
  await vic.tile('Sam').click();
  vic.wire.restore();
  await vic.connected();
  await expect(vic.tile('Sam')).toHaveClass(/share-live/);
  await expect.poll(() => vic.receivingShareFrom('Sam')).toBe(true);
  await expect.poll(async () => (await sam.peers()).find((p) => p.name === 'Vic')).toMatchObject({ subscribedToMe: true });
});

test('a Stop watching lost with its socket is said again after the reconnect', async ({ crowd }) => {
  // Quality ticket 10 (Grumpy Friend review): the stop went out, the socket dropped under it, and the sharer went on
  // sending to a viewer whose tile said "Click to watch". Nothing asked again: the black-share watchdog only re-asks a
  // watched tile.
  const [sam, vic] = await callOf(crowd, ['Sam', 'Vic']);
  await needHooks(sam);
  await sam.startShare();
  await vic.watchShare('Sam');
  await expect.poll(async () => (await sam.peers()).find((p) => p.name === 'Vic')).toMatchObject({ subscribedToMe: true });
  // Written, never delivered: the network drops the socket under it, the Room none the wiser.
  vic.wire.up = (frame) => (frame.includes('"t":"subscribe"') && frame.includes('"on":false') ? null : frame);
  await vic.tile('Sam').getByRole('button', { name: 'Stop watching' }).click();
  await expect(vic.tile('Sam')).toContainText('Click to watch');
  vic.wire.up = null;
  await vic.wire.cut();
  vic.wire.restore();
  await vic.connected();
  await expect.poll(async () => (await sam.peers()).find((p) => p.name === 'Vic'), { message: 'Sam stops sending to Vic' }).toMatchObject({ subscribedToMe: false });
});

test('a Stop sharing lost with its socket still ends the share for everyone', async ({ crowd }) => {
  // The join after the reconnect says what was declared last (quality ticket 10), not what the lost frame said.
  const [sam, vic] = await callOf(crowd, ['Sam', 'Vic']);
  await sam.startShare();
  await expect(vic.tile('Sam')).toBeVisible();
  sam.wire.up = (frame) => (frame.includes('"t":"share"') ? null : frame);
  await sam.stopShare();
  sam.wire.up = null;
  await sam.wire.cut();
  sam.wire.restore();
  await sam.connected();
  await expect(vic.page.locator('.share')).toHaveCount(0);
  await expect(vic.selectedRoom.locator('li.prow', { hasText: 'Sam' })).not.toContainText('sharing');
});

test('leaving while sharing ends the share; rejoining does not bring it back', async ({ crowd }) => {
  const [alice, bob] = await callOf(crowd, ['Alice', 'Bob']);
  await alice.startShare();
  await expect(bob.tile('Alice')).toBeVisible();
  await alice.leave();
  await expect(bob.page.locator('.share')).toHaveCount(0);
  await alice.join();
  await expect(alice.button('Share screen')).toBeVisible();
  await expect(alice.page.locator('.share')).toHaveCount(0);
  await expect(bob.selectedRoom.locator('li.prow', { hasText: 'Alice' })).not.toContainText('sharing');
});

test('regression: a viewer whose browser blocks autoplay gets the picture on a real click', async ({ crowd }) => {
  // Sep 2026: friends on Brave with autoplay set to Block saw a black tile while frames decoded fine.
  const sam = await crowd.open('Sam', { engine: 'chromium' });
  const vic = await crowd.open('Vic', { autoplay: 'blocked' });
  vic.expectWarning(/Autoplay is only allowed/); // Firefox says so while the tile waits for the click
  await sam.join();
  await vic.join();
  await vic.connectedTo('Sam');
  await sam.startShare();
  await vic.watchShare('Sam'); // Playwright's click is a trusted user gesture, like the friend's
  const video = vic.tile('Sam').locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  // The picture actually paints: the fake screen is colourful, a blocked element paints black.
  const brightness = () => video.evaluate((v: HTMLVideoElement) => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d')!; g.drawImage(v, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
    return sum / (d.length / 4) / 3;
  });
  await expect.poll(brightness).toBeGreaterThan(10);
});

test('share settings reach the capture and the encoder live', async ({ crowd, browserName }) => {
  test.skip(browserName !== 'chromium', 'the sharer is Chromium; one run is enough');
  const [alice, bob] = await callOf(crowd, ['Alice', 'Bob']);
  await needHooks(alice);
  await alice.startShare();
  await bob.watchShare('Alice');
  await alice.selectedRoom.getByTitle('Share settings').click();
  // Anchored: "Under pressure keep" offers "resolution" and "frame rate" as options too.
  await alice.page.locator('.panel label', { hasText: /^Frame rate/ }).locator('select').selectOption('15');
  await alice.page.locator('.panel label', { hasText: /^Resolution/ }).locator('select').selectOption('720');
  await expect.poll(async () => (await alice.hook<{ settings: { frameRate: number; maxHeight: number } }>('share')).settings).toMatchObject({ frameRate: 15, maxHeight: 720 });
  await expect.poll(async () => (await alice.hook<{ senders: Array<{ name: string; active: boolean; maxFramerate?: number }> }>('share')).senders.find((s) => s.name === 'Bob')).toMatchObject({ active: true, maxFramerate: 15 });
  await expect.poll(async () => (await alice.hook<{ track: { height?: number } | null }>('share')).track?.height ?? 9999).toBeLessThanOrEqual(720);
});
