import { expect, needHooks, test } from './fixtures';

// Audio settings, volumes, the problem report, and the phone layout.

test('turning audio processing off warns, and the change reaches the microphone track', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  await alice.join();
  await alice.selectedRoom.getByTitle('Audio settings').click();
  const panel = alice.page.locator('.panel');
  await expect(panel.locator('.hint', { hasText: 'usually makes you sound worse' })).toBeVisible();
  // Noise removal (ticket 26) stands in for the browser's noise suppression, whose box is off limits while it runs.
  await expect(panel.getByLabel('Noise suppression')).toBeDisabled();
  await panel.getByLabel('Noise removal').uncheck();
  await expect(panel.locator('.warn')).toHaveCount(0);
  await panel.getByLabel('Noise suppression').uncheck();
  await expect(panel.locator('.warn')).toContainText('Audio processing is off');
  await needHooks(alice);
  await expect.poll(async () => (await alice.hook<{ settings: { noiseSuppression: boolean } }>('audio')).settings.noiseSuppression).toBe(false);
  await panel.getByLabel('Noise suppression').check();
  await expect(panel.locator('.warn')).toHaveCount(0);
});

test('noise removal runs on the outgoing voice, the gate follows its slider, and switching it off sends the microphone again', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type Audio = { noiseRemoval: string; sending: string | null; settings: { voiceThreshold: number }; track: { noiseSuppression?: boolean } | null; level: { voice: number; open: boolean } };
  const audio = () => alice.hook<Audio>('audio');
  // Headless Firefox on a runner without a sound device never gets a running AudioContext (see the cue test): noise removal
  // then waits, and what must hold is that the microphone goes out as it is.
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  if (context !== 'running') {
    await expect.poll(async () => (await audio()).sending).toBe('microphone');
    await bob.hearing('Alice');
    test.skip(true, `no running AudioContext here (${context}), so noise removal waits; the microphone goes out as it is`);
  }
  await expect.poll(async () => (await audio()).noiseRemoval, { message: 'RNNoise runs' }).toBe('on');
  expect((await audio()).sending).toBe('processed');
  expect((await audio()).track?.noiseSuppression).not.toBe(true); // the browser's own suppression stepped aside
  await bob.hearing('Alice');

  await alice.selectedRoom.getByTitle('Audio settings').click();
  const gate = alice.page.locator('.panel').getByLabel('Voice gate');
  await gate.fill('0'); // all the way left: everything goes through
  await expect.poll(async () => (await audio()).settings.voiceThreshold).toBe(0);
  await expect.poll(async () => (await audio()).level.open, { message: 'the gate stands open' }).toBe(true);
  await gate.fill('100'); // the fake microphone beeps; no beep is a voice
  await expect.poll(async () => (await audio()).settings.voiceThreshold).toBe(0.95);
  await expect.poll(async () => (await audio()).level.open, { message: 'the gate shuts on a beep' }).toBe(false);

  await alice.page.locator('.panel').getByLabel('Noise removal').uncheck();
  await expect.poll(async () => (await audio()).sending).toBe('microphone');
  expect((await audio()).noiseRemoval).toBe('off');
  await bob.hearing('Alice');
});

test('low bandwidth voice caps the voice both ways from one side, and the delay to each friend shows beside the name', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  await expect(alice.selectedRoom.locator('li.prow', { hasText: 'Bob' }).locator('.lag')).toHaveText(/^\d+ ms$/);

  type Voice = { packetsSent?: number; bytesSent?: number };
  type Diag = { lowBandwidthVoice: boolean; peers: Array<{ asksLowVoice: boolean; outboundVoice: Voice | null }> };
  const sent = async (f: typeof alice) => (await f.hook<Diag>('diagnostics')).peers[0]?.outboundVoice ?? {};
  /** What one friend's voice encoder puts out over two seconds: packets per second, payload kbps. Engine-neutral: Firefox's codec stats show its own fmtp, not the one it obeys. */
  const rate = async (f: typeof alice) => {
    const a = await sent(f);
    await f.page.waitForTimeout(2000);
    const b = await sent(f);
    return { pps: ((b.packetsSent ?? 0) - (a.packetsSent ?? 0)) / 2, kbps: (((b.bytesSent ?? 0) - (a.bytesSent ?? 0)) * 8) / 2000 };
  };
  const low = (r: { pps: number; kbps: number }) => r.pps < 20 && r.kbps <= 14; // 60 ms packets at 12 kbps, fewer still in silence
  const full = (r: { pps: number; kbps: number }) => r.pps > 40; // 20 ms packets
  await expect.poll(() => rate(alice).then(full), { message: 'full voice at first' }).toBe(true);

  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel').getByLabel('Low bandwidth voice').check();
  // Alice's own encoder follows the rewritten answer, Bob's the rewritten offer: Alice alone switched it on.
  for (const f of [alice, bob]) await expect.poll(() => rate(f).then(low), { message: `${f.name} sends low bandwidth voice` }).toBe(true);
  expect((await bob.hook<Diag>('diagnostics')).peers[0]?.asksLowVoice).toBe(true);
  await bob.hearing('Alice');
  await alice.hearing('Bob');

  await alice.page.reload(); // the setting is remembered, and a fresh connection starts with it
  await alice.connectedTo('Bob');
  await expect.poll(() => rate(bob).then(low), { message: 'Bob sends low bandwidth voice to the reloaded Alice' }).toBe(true);

  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel').getByLabel('Low bandwidth voice').uncheck();
  for (const f of [alice, bob]) await expect.poll(() => rate(f).then(full), { message: `${f.name} is back to full voice` }).toBe(true);
  await bob.hearing('Alice');
});

test('a friend\'s volume and the master volume multiply, and survive a reload', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  const gainOfBob = async () => (await alice.hook<{ peers: Array<{ name: string; voiceGain: number | null }> }>('volumes')).peers.find((p) => p.name === 'Bob')?.voiceGain;

  await alice.selectedRoom.locator('li.prow', { hasText: 'Bob' }).locator('button.vol').click();
  await alice.selectedRoom.locator('.volrow input[type=range]').fill('150');
  await expect.poll(gainOfBob).toBeCloseTo(1.5);
  await expect(alice.selectedRoom.locator('li.prow', { hasText: 'Bob' }).locator('button.vol')).toContainText('150%');

  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel label.mvol input[type=range]').fill('50');
  await expect.poll(gainOfBob).toBeCloseTo(0.75);

  await alice.page.reload();
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible(); // a reload rejoins the call by itself (ticket 24)
  await alice.connectedTo('Bob');
  await expect.poll(gainOfBob).toBeCloseTo(0.75);
});

test('a problem report is sent to the error log, with the friend told so', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { plainUserAgent: true });
  await alice.page.getByRole('button', { name: 'Report a problem' }).click();
  const dialog = alice.page.locator('dialog.report');
  await dialog.locator('select').selectOption('text');
  await dialog.getByLabel(/Blocking/).check();
  await dialog.locator('textarea').fill('automated test report, please ignore');
  const before = alice.posthog.length;
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.locator('.ok')).toContainText('Sent, thank you');
  await expect.poll(() => alice.posthog.length, { message: 'the report went out (to the local stand-in for PostHog)' }).toBeGreaterThan(before);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).not.toBeVisible();
});

test('phone width: one column, the composer pinned to the bottom of the screen and usable', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', { viewport: { width: 390, height: 780 } });
  for (let i = 0; i < 30; i++) await alice.say(`line ${i}`);
  await expect.poll(async () => (await bob.chatTexts()).length).toBe(30);
  const box = await bob.composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(780);
  expect(box!.y).toBeGreaterThan(780 - 120);
  expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390); // no sideways scrolling
  await bob.say('from the phone');
  await expect.poll(() => alice.chatTexts()).toContain('from the phone');
});
