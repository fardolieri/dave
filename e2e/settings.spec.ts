import { expect, needHooks, test } from './fixtures';

// Audio settings, volumes, the problem report, and the phone layout.

test('turning audio processing off warns, and the change reaches the microphone track live', async ({ crowd, browserName }) => {
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
  // Firefox's fake microphone runs no processing whatever it is asked for, so only Chromium's can show the change arriving.
  test.skip(browserName !== 'chromium', 'the fake microphone reports no processing here');
  // What the microphone reports, not the stored setting: Chromium keeps a track's processing whatever applyConstraints says,
  // so a change mid-call opens the microphone again.
  type Track = { track: { echoCancellation?: boolean; noiseSuppression?: boolean } | null };
  const track = async () => (await alice.hook<Track>('audio')).track;
  await expect.poll(async () => (await track())?.noiseSuppression).toBe(true);
  await panel.getByLabel('Noise suppression').uncheck();
  await expect.poll(async () => (await track())?.noiseSuppression).toBe(false);
  await panel.getByLabel('Noise suppression').check();
  await expect.poll(async () => (await track())?.noiseSuppression).toBe(true);
  await panel.getByLabel('Echo cancellation').uncheck();
  await expect.poll(async () => (await track())?.echoCancellation).toBe(false);
  await panel.getByLabel('Echo cancellation').check();
  await expect.poll(async () => (await track())?.echoCancellation).toBe(true);
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

test('noise removal keeps time with the microphone, and stops itself only when friends would hear it go wrong', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type Load = { pct: number; droppedMs: number };
  type Audio = { noiseRemoval: string; sending: string | null; path: string | null; stop: string | null; deliveredMs: number | null; load: Load | null };
  type Hooks = { skewVoiceClock(f: number): void; strainVoice(l: Partial<Load>): void };
  const audio = () => alice.hook<Audio>('audio');
  const dave = (f: (d: Hooks) => void) => alice.page.evaluate(`(${f.toString()})(window.__dave)`);
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  const frames = await alice.page.evaluate(() => typeof (window as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === 'function');
  test.skip(!frames && context !== 'running', `no microphone frames and no running AudioContext here (${context}): noise removal waits`);
  await expect.poll(async () => (await audio()).noiseRemoval, { message: 'RNNoise runs' }).toBe('on');
  // Chromium hands out the microphone's own frames; Firefox keeps the worklet in its own AudioContext.
  expect((await audio()).path).toBe(frames ? 'frames' : 'context');
  expect((await audio()).sending).toBe('processed');
  await bob.hearing('Alice');

  const first = await audio();
  test.skip(first.deliveredMs === null, 'this browser does not count the audio a track delivers, so nothing watches the clock');
  const t0 = Date.now();
  await alice.page.waitForTimeout(5000);
  const second = await audio();
  const rate = (second.deliveredMs! - first.deliveredMs!) / (Date.now() - t0);
  expect(rate, 'the processed voice goes out in real time').toBeGreaterThan(0.95);
  expect(rate).toBeLessThan(1.05);
  expect(second.load, 'the worker keeps up with the microphone').toMatchObject({ droppedMs: 0 });

  // The worker path cannot drift: a clock reading 5 percent fast is no reason to stop (it stopped a friend's on 2 Oct).
  await dave((d) => d.skewVoiceClock(1.05));
  await alice.page.waitForTimeout(18_000);
  expect((await audio()).noiseRemoval, 'a skewed clock leaves the worker path alone').toBe('on');
  await dave((d) => d.skewVoiceClock(1));

  // A worker that keeps losing the microphone's frames: noise removal gives up and the microphone goes out as it is.
  await dave((d) => d.strainVoice({ droppedMs: 300 }));
  await expect.poll(async () => (await audio()).noiseRemoval, { timeout: 15_000, message: 'noise removal stops' }).toBe('unavailable');
  expect(await audio()).toMatchObject({ sending: 'microphone', stop: 'overload' });
  await alice.selectedRoom.getByTitle('Audio settings').click();
  await expect(alice.page.locator('.panel')).toContainText('Noise removal stopped: this device could not keep up with it');
  await bob.hearing('Alice');

  // Switching it off and on tries again.
  await dave((d) => d.strainVoice({}));
  const toggle = alice.page.locator('.panel').getByLabel('Noise removal');
  await toggle.uncheck();
  await toggle.check();
  await expect.poll(async () => (await audio()).noiseRemoval).toBe('on');
  expect((await audio()).stop).toBeNull();
});

test('ticket 40: the mic test plays my voice as friends get it, while friends get silence, see me muted, and go unheard', async ({ crowd, browserName }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type MicTest = { phase: string | null; clip: boolean; playing: boolean; follows: string | null; level: number | null; wire: string | null };
  const test40 = () => alice.hook<MicTest>('micTest');
  const bobGain = async () => (await alice.hook<{ peers: Array<{ name: string; voiceGain: number | null }> }>('volumes')).peers.find((p) => p.name === 'Bob')?.voiceGain;
  const aliceRow = bob.selectedRoom.locator('li.prow', { hasText: 'Alice' });
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  test.skip(context !== 'running', `no running AudioContext here (${context}): nothing to play the test through`);
  await expect.poll(async () => (await alice.hook<{ noiseRemoval: string }>('audio')).noiseRemoval, { message: 'RNNoise runs' }).toBe('on');

  await alice.selectedRoom.getByTitle('Audio settings').click();
  const panel = alice.page.locator('.panel');
  await panel.getByLabel('Voice gate').fill('0'); // the fake microphone beeps, which the gate would shut on
  const live = panel.getByRole('button', { name: 'Hear yourself' });
  await live.click();
  await expect.poll(async () => (await test40()).phase).toBe('live');
  await expect(panel.locator('.warn', { hasText: "Friends can't hear you" })).toBeVisible();
  expect((await test40()).wire).toBe('silence');
  await expect(aliceRow).toContainText('muted');
  await expect.poll(bobGain, { message: 'Bob goes unheard' }).toBe(0);
  await expect.poll(async () => (await test40()).playing).toBe(true);
  const echo = async () => (await alice.hook<{ track: { echoCancellation?: boolean } | null }>('audio')).track?.echoCancellation;
  // Firefox's fake microphone runs no processing whatever it is asked for: there echo cancellation always reads off.
  if (browserName === 'chromium') await expect.poll(echo, { message: 'echo cancellation steps aside while I hear myself' }).toBe(false);
  expect((await test40()).follows).toBe('processed');
  // Firefox's fake microphone is a steady tone, which RNNoise takes out entirely. Chromium's beeps are no voice either:
  // RNNoise lets the first ones through, then within a second leaves about 3e-5 of them, against 1e-14 or less with
  // nothing playing. Flaky until then, 4 in 40 (run 37887013263): it asked for 0.001, which only the first beeps reach.
  // The level of the voice as it is follows below, with noise removal off.
  if (browserName === 'chromium') await expect.poll(async () => (await test40()).level ?? 0, { message: 'my processed voice plays' }).toBeGreaterThan(1e-6);
  // A setting changed mid-test: the test follows the voice that would go out, here the microphone as it is.
  await alice.cuesPlayed();
  await carol.join(); // no join cue: I hear nothing but myself
  await expect.poll(() => alice.inCall().then((n) => n.length)).toBe(3);
  await alice.page.waitForTimeout(500);
  expect(await alice.cuesPlayed()).toEqual([]);
  await panel.getByLabel('Noise removal').uncheck();
  await expect.poll(async () => (await alice.hook<{ sending: string }>('audio')).sending).toBe('microphone');
  expect((await test40()).follows).toBe('microphone');
  await expect.poll(async () => (await test40()).level ?? 0, { message: 'the microphone as it is plays' }).toBeGreaterThan(0.001);
  expect((await test40()).wire).toBe('silence');
  await live.click(); // the lit button ends it
  await expect.poll(async () => (await test40()).phase).toBe(null);
  if (browserName === 'chromium') await expect.poll(echo, { message: 'echo cancellation is back' }).toBe(true);
  expect((await test40()).wire).toBe('voice');
  await expect(aliceRow).not.toContainText('muted');
  await expect.poll(bobGain).toBe(1);
  await bob.hearing('Alice');

  // Record 5 s: the recording plays back by itself, and the call comes back once it has played.
  await panel.getByRole('button', { name: 'Record 5 s' }).click();
  await expect.poll(async () => (await test40()).phase).toBe('recording');
  await expect(aliceRow).toContainText('muted');
  await expect.poll(async () => (await test40()).phase, { timeout: 10_000 }).toBe('playing');
  expect((await test40()).clip).toBe(true);
  const recorded = await alice.hook<{ seconds: number; peak: number }>('micTestClip');
  expect(recorded.seconds, 'about 5 s recorded').toBeGreaterThan(4);
  expect(recorded.peak, 'the recording holds my voice').toBeGreaterThan(0.001);
  await expect.poll(async () => (await test40()).phase, { timeout: 15_000, message: 'the recording played to its end' }).toBe(null);
  await expect(aliceRow).not.toContainText('muted');
  await expect.poll(bobGain).toBe(1);

  // Play it again, then close the panel: closing ends the test.
  await panel.getByRole('button', { name: 'Play' }).click();
  await expect.poll(async () => (await test40()).phase).toBe('playing');
  await alice.selectedRoom.getByTitle('Audio settings').click();
  await expect.poll(async () => (await test40()).phase).toBe(null);
  await expect(aliceRow).not.toContainText('muted');

  // Muted before the test: the test still hears me, Mute ends it, and I stay muted.
  await alice.selectedRoom.getByRole('button', { name: 'Mute' }).click();
  await expect(aliceRow).toContainText('muted');
  await alice.selectedRoom.getByTitle('Audio settings').click();
  await live.click();
  await expect.poll(async () => (await test40()).level ?? 0, { message: 'a muted microphone still plays in the test' }).toBeGreaterThan(0.001);
  await alice.selectedRoom.getByRole('button', { name: 'Unmute' }).click();
  await expect.poll(async () => (await test40()).phase).toBe(null);
  await expect(aliceRow).not.toContainText('muted');
  expect((await test40()).wire).toBe('voice');
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
  type Inbound = { jitterBufferTargetDelay?: number; jitterBufferEmittedCount?: number };
  type Diag = { lowBandwidthVoice: boolean; peers: Array<{ asksLowVoice: boolean; outboundVoice: Voice | null; inboundVoice: Inbound | null }> };
  /** The voice buffer (ticket 28): what the receiver was asked for, and the target the browser says it held over two seconds, in ms. */
  const voiceBuffer = async (f: typeof alice) => {
    const inbound = async () => (await f.hook<Diag>('diagnostics')).peers[0]?.inboundVoice ?? {};
    const a = await inbound();
    await f.page.waitForTimeout(2000);
    const b = await inbound();
    const n = (b.jitterBufferEmittedCount ?? 0) - (a.jitterBufferEmittedCount ?? 0);
    const asked = (await f.hook<Array<{ voiceBufferMs: number | null }>>('peers'))[0]?.voiceBufferMs ?? null;
    return { asked, targetMs: n > 0 ? (((b.jitterBufferTargetDelay ?? 0) - (a.jitterBufferTargetDelay ?? 0)) / n) * 1000 : 0 };
  };
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
  // Both play the other's voice from a longer buffer. Firefox holds about half of it (100 ms of the 200 asked, 2026-09-27).
  for (const f of [alice, bob]) await expect.poll(() => voiceBuffer(f), { message: `${f.name} buffers the voice longer` }).toMatchObject({ asked: 200, targetMs: expect.any(Number) });
  for (const f of [alice, bob]) expect((await voiceBuffer(f)).targetMs).toBeGreaterThanOrEqual(150);
  expect((await bob.hook<Diag>('diagnostics')).peers[0]?.asksLowVoice).toBe(true);
  await bob.hearing('Alice');
  await alice.hearing('Bob');

  await alice.page.reload(); // the setting is remembered, and a fresh connection starts with it
  await alice.connectedTo('Bob');
  await expect.poll(() => rate(bob).then(low), { message: 'Bob sends low bandwidth voice to the reloaded Alice' }).toBe(true);

  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel').getByLabel('Low bandwidth voice').uncheck();
  // Flaked once in Firefox against nightly (2026-10-08, run 37784001226): the Room dropped both sockets right after this
  // offer went out, it was lost, and Alice's voice stayed low. The app wrongly never sent it again; now it does (see
  // resendOffer in client/call.ts, and its test in resilience.spec.ts).
  for (const f of [alice, bob]) await expect.poll(() => rate(f).then(full), { message: `${f.name} is back to full voice` }).toBe(true);
  for (const f of [alice, bob]) expect((await voiceBuffer(f)).asked).toBeNull();
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

test('voice repair: RED chosen by one side doubles the voice packets both ways, off drops the FEC flag, and a browser without RED keeps plain Opus', async ({ crowd, browserName }) => {
  // In the Firefox project Alice runs Firefox, which has no RED (2026-09-28), against a Chromium Bob: her choice must change nothing.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob', browserName === 'firefox' ? { engine: 'chromium' } : {});
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);

  type Voice = { packetsSent?: number; bytesSent?: number; fmtp?: string };
  type Diag = { voiceRepair: string; peers: Array<{ sendsRed: boolean; sendsFec: boolean; outboundVoice: Voice | null }> };
  const sent = async (f: typeof alice) => (await f.hook<Diag>('diagnostics')).peers[0]?.outboundVoice ?? {};
  /** Bytes per voice packet one friend sends over two seconds: about 80 with plain Opus, about 140 with RED (a copy of the previous packet rides along). */
  const bytesPerPacket = async (f: typeof alice) => {
    const a = await sent(f);
    await f.page.waitForTimeout(2000);
    const b = await sent(f);
    const n = (b.packetsSent ?? 0) - (a.packetsSent ?? 0);
    return n > 0 ? ((b.bytesSent ?? 0) - (a.bytesSent ?? 0)) / n : 0;
  };
  // Sizes depend on the engine and on what the fake microphone gives the gate (about 43 bytes of near-silence in Chromium, 35 in
  // Firefox), so each friend is judged against their own start: RED carries the previous packet along, so packets grow by half at least.
  const baseline = new Map<string, number>();
  for (const f of [alice, bob]) { const b = await bytesPerPacket(f); expect(b, `${f.name} sends voice at first`).toBeGreaterThan(20); baseline.set(f.name, b); }
  const plain = (f: typeof alice) => async () => { const b = await bytesPerPacket(f); return b > baseline.get(f.name)! * 0.6 && b < baseline.get(f.name)! * 1.4; };
  const red = (f: typeof alice) => async () => (await bytesPerPacket(f)) >= baseline.get(f.name)! * 1.5;
  expect((await alice.hook<Diag>('diagnostics')).voiceRepair).toBe('fec');

  await alice.selectedRoom.getByTitle('Audio settings').click();
  await alice.page.locator('.panel').getByLabel('RED').check();
  if (browserName === 'firefox') {
    await alice.page.waitForTimeout(3000); // the offer goes round; nothing about RED can change
    for (const f of [alice, bob]) expect(await red(f)(), `${f.name} still sends plain Opus`).toBe(false);
    for (const f of [alice, bob]) expect((await f.hook<Diag>('diagnostics')).peers[0]?.sendsRed).toBe(false);
  } else {
    for (const f of [alice, bob]) await expect.poll(red(f), { message: `${f.name} sends RED` }).toBe(true);
    for (const f of [alice, bob]) expect((await f.hook<Diag>('diagnostics')).peers[0]?.sendsRed).toBe(true);
  }
  await bob.hearing('Alice');
  await alice.hearing('Bob');

  await alice.page.locator('.panel').getByLabel('Off').check();
  // Each side's encoder reads the flag from its remote description, as applied; the stats' codec line is not a reliable mirror
  // of it (Chromium showed the answerer's own fmtp there, 2026-09-28), so the description itself is checked.
  for (const f of [alice, bob]) await expect.poll(plain(f), { message: `${f.name} is back to plain Opus` }).toBe(true);
  for (const f of [alice, bob]) await expect.poll(() => f.hook<Diag>('diagnostics').then((d) => d.peers[0]?.sendsFec), { message: `${f.name} sends without FEC` }).toBe(false);
  for (const f of [alice, bob]) expect((await f.hook<Diag>('diagnostics')).peers[0]?.sendsRed).toBe(false);
  await bob.hearing('Alice');

  await alice.page.locator('.panel').getByLabel('Opus FEC').check();
  for (const f of [alice, bob]) await expect.poll(() => f.hook<Diag>('diagnostics').then((d) => d.peers[0]?.sendsFec), { message: `${f.name} sends with FEC again` }).toBe(true);
  await bob.hearing('Alice');
});

test('the voice is measured every five seconds, and a clean line leaves the buffer to the browser', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type PeerHook = { lastWindow: { seconds: number; packets: number; concealedPct: number; jitterMs: number; bufferMs: number } | null; adaptiveMs: number | null; voiceBufferMs: number | null };
  const measured = async () => (await alice.hook<PeerHook[]>('peers'))[0] ?? null;
  await expect.poll(async () => (await measured())?.lastWindow?.packets ?? 0, { message: 'a 5 s window of Bob\'s voice', timeout: 15_000 }).toBeGreaterThan(40);
  const p = (await measured())!;
  expect(p.lastWindow).toMatchObject({ seconds: expect.any(Number), jitterMs: expect.any(Number), bufferMs: expect.any(Number) });
  expect(p.lastWindow!.seconds).toBeGreaterThanOrEqual(4);
  expect(p.lastWindow!.concealedPct).toBeLessThan(3);
  expect(p.adaptiveMs).toBeNull();
  expect(p.voiceBufferMs).toBeNull();
});
