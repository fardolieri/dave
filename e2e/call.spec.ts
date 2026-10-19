import { expect, needHooks, test, type Friend } from './fixtures';

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

test('a friend without a microphone joins to listen, shown muted; Unmute takes one plugged in later', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const nick = await crowd.open('Nick', { connect: false });
  // The browser finds no microphone until the test plugs one in.
  await nick.context.addInitScript(() => {
    const w = window as unknown as { __micPlugged: boolean };
    w.__micPlugged = false;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => (c?.audio && !w.__micPlugged ? Promise.reject(new DOMException('Requested device not found', 'NotFoundError')) : real(c));
  });
  await nick.open();
  await alice.join();
  await nick.join();
  const hint = nick.selectedRoom.locator('.hint', { hasText: 'No microphone found.' });
  await expect(hint).toBeVisible();
  await alice.connectedTo('Nick');
  await nick.connectedTo('Alice');
  const nickRow = alice.selectedRoom.locator('li.prow', { hasText: 'Nick' });
  await expect(nickRow).toContainText('muted');
  await needHooks(nick);
  await nick.hearing('Alice');
  await nick.button('Unmute').click(); // still none: keeps listening
  await expect(hint).toBeVisible();
  await expect(nick.button('Unmute')).toBeVisible();
  await nick.page.evaluate(() => { (window as unknown as { __micPlugged: boolean }).__micPlugged = true; });
  await nick.button('Unmute').click();
  await expect(nick.button('Mute')).toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(nickRow).not.toContainText('muted');
  await alice.hearing('Nick');
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

/** A headset with its own mute switch: the track stays live and enabled, and carries zeros while the switch is off. */
async function withHeadsetSwitch(friend: Friend): Promise<void> {
  await friend.context.addInitScript(() => {
    const gains: GainNode[] = [];
    let on = true;
    (window as unknown as { __headset: (on: boolean) => void }).__headset = (v) => { on = v; for (const g of gains) g.gain.value = v ? 1 : 0; };
    const media = navigator.mediaDevices;
    const real = media.getUserMedia.bind(media);
    media.getUserMedia = async (c) => {
      const raw = await real(c);
      const input = raw.getAudioTracks()[0];
      if (!input || c?.video) return raw;
      const ctx = new AudioContext();
      void ctx.resume();
      const gain = ctx.createGain();
      gain.gain.value = on ? 1 : 0;
      gains.push(gain);
      const out = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(raw).connect(gain).connect(out);
      // The fake device only beeps: a steady level besides, as a live room has, so the typical level is above the line.
      const room = ctx.createConstantSource();
      room.offset.value = 0.01;
      room.connect(gain);
      room.start();
      const track = out.stream.getAudioTracks()[0]!;
      // The app reads the processing a capture runs (call.ts, takes): the real track's, so it reopens as it would.
      track.getSettings = () => input.getSettings();
      const stop = track.stop.bind(track);
      let stopped = false;
      track.stop = () => { if (stopped) return; stopped = true; stop(); input.stop(); ctx.close().catch(() => {}); };
      return out.stream;
    };
  });
}

test('a microphone silent for a minute asks in the title, on my row and out loud, through a settings change, until sound comes', async ({ crowd, browserName }) => {
  test.skip(browserName !== 'chromium', 'Firefox\'s fake microphone runs no processing, and headless Firefox gets no running AudioContext');
  test.setTimeout(240_000);
  const alice = await crowd.open('Alice', { connect: false, picture: '🦊' });
  await withHeadsetSwitch(alice);
  await alice.open();
  await alice.join();
  await needHooks(alice);
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  test.skip(context !== 'running', `no running AudioContext here (${context}): the microphone is never read`);
  await expect(alice.page).toHaveTitle('dave 🦊');
  await alice.page.evaluate(() => (window as unknown as { __headset: (on: boolean) => void }).__headset(false));
  await alice.cuesPlayed();
  const asked = alice.selectedRoom.locator('li.prow em.micsilent');
  await expect(alice.page).toHaveTitle('🔇❓ dave 🦊', { timeout: 80_000 });
  await expect(asked).toBeVisible();
  await expect.poll(async () => (await alice.cuesPlayed()).join(','), { message: 'asked out loud' }).toContain('sine 523,sine 392,sine 523');
  // Checking the settings opens the microphone again: no sound came, so the question stays.
  await alice.selectedRoom.getByTitle('Audio settings').click();
  const panel = alice.page.locator('.panel');
  const echo = async () => (await alice.hook<{ track: { echoCancellation?: boolean } | null }>('audio')).track?.echoCancellation;
  await panel.getByLabel('Echo cancellation').uncheck();
  await expect.poll(echo).toBe(false);
  await panel.getByLabel('Echo cancellation').check();
  await expect.poll(echo).toBe(true);
  await alice.page.waitForTimeout(1000);
  await expect(alice.page).toHaveTitle('🔇❓ dave 🦊');
  await expect(asked).toBeVisible();
  await alice.page.evaluate(() => (window as unknown as { __headset: (on: boolean) => void }).__headset(true)); // the room is heard again
  await expect(alice.page).toHaveTitle('dave 🦊');
  await expect(asked).toHaveCount(0);
  await alice.leave();
  await expect(alice.page).toHaveTitle('dave');
});

test('ticket 39: starting a share plays the sharer\'s cue with a high C6 on top, for everyone and the sharer', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob', { picture: '🐸' }); // no wobble, so the cue's first notes match the join's
  const heard = async (f: typeof alice) => { let got: string[] = []; await expect.poll(async () => (got = await f.cuesPlayed()).length, { message: `${f.name} hears a cue` }).toBeGreaterThan(0); return got; };
  await alice.join();
  await needHooks(alice);
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  test.skip(context !== 'running', `no running AudioContext here (${context}), so no cue can play`);
  await heard(alice); // my own join
  await bob.join();
  const bobJoin = await heard(alice);
  await bob.cuesPlayed(); // Bob's own join, and Alice's
  await bob.startShare();
  const share = await heard(alice);
  expect(share.slice(0, bobJoin.length)).toEqual(bobJoin); // Bob's own tune first
  expect(share.at(-1)).toBe('sine 1047'); // then the sparkle
  expect((await heard(bob)).at(-1)).toBe('sine 1047'); // Bob hears his own
});
