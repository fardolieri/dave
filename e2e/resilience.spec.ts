import { expect, needHooks, test, type Friend } from './fixtures';

test('the call survives the server going away and coming back', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  await alice.wire.cut();
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  // Voice keeps flowing peer to peer while the server is gone.
  await expect(alice.badge('Bob')).toHaveText('direct');
  if (await alice.hasHooks()) await alice.hearing('Bob');

  alice.wire.restore();
  await alice.connected();
  await expect(alice.banner).toHaveCount(0);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
});

test('a friend whose socket drops without a goodbye is shown as lost, then recovers', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  await needHooks(alice);
  await alice.page.evaluate(() => (window as unknown as { __dave: { dropSocket: () => void } }).__dave.dropSocket());
  await alice.connected();
  await bob.connectedTo('Alice');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('an offer lost with a dropped socket, on either side, is sent again once the socket is back', async ({ crowd }) => {
  // Nightly, 2026-10-08 (the low bandwidth voice test, Firefox): the Room dropped both sockets the moment Alice switched
  // low bandwidth voice off, her offer went with them, and her connection waited for its answer for good, still low.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type Diag = { peers: Array<{ asksLowVoice: boolean; pc: { signaling: string } }> };
  const peer = async (f: typeof alice) => (await f.hook<Diag>('diagnostics')).peers[0];
  let lost = 0;
  const lostOffer = (frame: string) => (frame.includes('"t":"signal"') && frame.includes('"type":"offer"') ? (lost++, null) : frame);
  const lowVoice = async (on: boolean) => {
    const before = lost;
    await alice.selectedRoom.getByTitle('Audio settings').click();
    await alice.page.locator('.panel').getByLabel('Low bandwidth voice').setChecked(on);
    await alice.selectedRoom.getByTitle('Audio settings').click();
    await expect.poll(() => lost, { message: 'the offer is lost' }).toBe(before + 1);
    expect((await peer(alice))?.pc.signaling, 'Alice waits for an answer').toBe('have-local-offer');
  };

  // Alice's own socket drops with her offer on it.
  alice.wire.up = lostOffer;
  await lowVoice(true);
  alice.wire.up = null;
  await alice.wire.cut();
  alice.wire.restore();
  await alice.connected();
  await expect.poll(async () => (await peer(bob))?.asksLowVoice, { message: 'Bob got the offer after Alice came back' }).toBe(true);
  await expect.poll(async () => (await peer(alice))?.pc.signaling, { message: 'Alice got the answer' }).toBe('stable');

  // Bob's socket drops with Alice's offer on its way to him.
  bob.wire.down = lostOffer;
  await lowVoice(false);
  bob.wire.down = null;
  await bob.wire.cut();
  bob.wire.restore();
  await bob.connected();
  await expect.poll(async () => (await peer(bob))?.asksLowVoice, { message: 'Bob got the offer after he came back' }).toBe(false);
  await expect.poll(async () => (await peer(alice))?.pc.signaling, { message: 'Alice got the answer' }).toBe('stable');
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});

// What an offer sent again must not do (review of the fix above): be answered twice and have the late answer taken for a
// newer offer, or reach a friend who reloaded meanwhile and tangle their new connection.
type PeerHook = { name: string; generation: number; transceivers: number; asksLowVoice: boolean; signaling: string; remoteUfrag: string | null };
const peerOf = async (f: Friend) => (await f.hook<PeerHook[]>('peers'))[0];
const isSignal = (type: 'offer' | 'answer') => (frame: string) => frame.includes('"t":"signal"') && frame.includes(`"type":"${type}"`);
const ufragOf = (frame: string) => /a=ice-ufrag:(\S+)/.exec((JSON.parse(frame) as { data: { description: { sdp: string } } }).data.description.sdp)?.[1];
async function lowVoice(f: Friend, on: boolean): Promise<void> {
  await f.selectedRoom.getByTitle('Audio settings').click();
  await f.page.locator('.panel').getByLabel('Low bandwidth voice').setChecked(on);
  await f.selectedRoom.getByTitle('Audio settings').click();
}

test('a late second answer to an offer sent again is never applied to a newer offer', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  // Bob's signals to Alice from his first answer on are held back, in order: his candidates follow the answer they belong to.
  const held: string[] = [];
  alice.wire.down = (frame) => (isSignal('answer')(frame) || (held.length > 0 && frame.includes('"t":"signal"')) ? (held.push(frame), null) : frame);
  const answers = () => held.filter(isSignal('answer'));

  // Alice offers; Bob's answer is held back. Her socket drops and comes back, she sends the offer again, Bob answers again.
  await lowVoice(alice, true);
  await expect.poll(() => answers().length, { message: 'Bob answers the offer' }).toBe(1);
  await alice.wire.cut();
  alice.wire.restore();
  await alice.connected();
  await expect.poll(() => answers().length, { message: 'Bob answers the offer sent again' }).toBe(2);

  // The first answer arrives; then an ICE restart offers anew, and the late second answer comes before the real one.
  const [first, late] = answers();
  alice.wire.deliver(first!);
  await expect.poll(async () => (await peerOf(alice))?.signaling).toBe('stable');
  await alice.hook('restartIce', 'Bob');
  await expect.poll(() => answers().length, { message: 'Bob answers the ICE restart' }).toBe(3);
  const restart = answers()[2]!;
  expect(ufragOf(restart), 'the restart gives Bob new ICE credentials').not.toBe(ufragOf(late!));
  for (const f of held) if (f !== first) alice.wire.deliver(f);
  alice.wire.down = null;
  await expect.poll(async () => (await peerOf(alice))?.remoteUfrag, { message: "Alice holds Bob's credentials from his answer to the restart" }).toBe(ufragOf(restart));
  expect((await peerOf(alice))?.signaling).toBe('stable');
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});

for (const polite of [true, false]) for (const newest of [true, false]) {
  const who = `the ${polite ? 'polite' : 'impolite'} side reloads, ${newest ? 'the last to join' : 'the first to join'}`;
  test(`an offer stuck for a friend who then reloads leaves their new connection alone (${who})`, async ({ crowd }) => {
    // The polite side would take up the stale offer in place of its own fresh one. The last to join gets the same join
    // sequence back after a reload; the first gets a new one.
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    await alice.join();
    await bob.join();
    await alice.connectedTo('Bob');
    await needHooks(alice);
    const alicePolite = (await alice.hook<{ peers: Array<{ polite: boolean }> }>('diagnostics')).peers[0]!.polite;
    const [reloader, offerer] = alicePolite === polite ? [alice, bob] : [bob, alice];
    if ((newest ? reloader : offerer) === alice) {
      // Bob joined last; Alice joins again to be the last.
      await alice.leave();
      await alice.join();
      await alice.connectedTo('Bob');
      await bob.connectedTo('Alice');
    }
    let lost = 0;
    reloader.wire.down = (frame) => (isSignal('offer')(frame) && lost++ === 0 ? null : frame);
    await lowVoice(offerer, true);
    await expect.poll(() => lost, { message: 'the offer is lost' }).toBe(1);
    expect((await peerOf(offerer))?.signaling, `${offerer.name} waits for an answer`).toBe('have-local-offer');
    reloader.wire.down = null;

    const offers = () => offerer.wire.log.filter((l) => l.dir === 'up' && isSignal('offer')(l.frame)).length;
    const offersBefore = offers();
    await reloader.page.reload();
    await reloader.connected();
    await expect(reloader.button('Leave')).toBeVisible(); // a reload rejoins the call by itself (ticket 24)
    await expect.poll(offers, { message: `${offerer.name} sends the stuck offer again` }).toBeGreaterThan(offersBefore);

    await offerer.connectedTo(reloader.name);
    await reloader.connectedTo(offerer.name);
    for (const f of [offerer, reloader]) await expect.poll(async () => (await peerOf(f))?.signaling, { message: `${f.name} is stable` }).toBe('stable');
    const fresh = await peerOf(reloader);
    expect(fresh?.generation, `${reloader.name}'s page built one connection, no rebuild`).toBe(1);
    expect(fresh?.transceivers).toBe(3);
    expect(fresh?.asksLowVoice, `${reloader.name} reads ${offerer.name}'s ask`).toBe(true);
    await offerer.hearing(reloader.name);
    await reloader.hearing(offerer.name);
  });
}

test('both sockets drop with an offer of each in flight, and both settle with the ask read', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  for (const f of [alice, bob]) {
    let lost = 0;
    f.wire.up = (frame) => (isSignal('offer')(frame) ? (lost++, null) : frame);
    await lowVoice(f, true);
    await expect.poll(() => lost, { message: `${f.name}'s offer is lost` }).toBe(1);
  }
  for (const f of [alice, bob]) expect((await peerOf(f))?.signaling, `${f.name} waits for an answer`).toBe('have-local-offer');
  await Promise.all([alice.wire.cut(), bob.wire.cut()]);
  for (const f of [alice, bob]) { f.wire.up = null; f.wire.restore(); }
  await alice.connected();
  await bob.connected();
  for (const f of [alice, bob]) {
    await expect.poll(async () => (await peerOf(f))?.signaling, { message: `${f.name} is stable` }).toBe('stable');
    await expect.poll(async () => (await peerOf(f))?.asksLowVoice, { message: `${f.name} reads the other's ask` }).toBe(true);
  }
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});

test('a friend cut off from the server stays in the call, dimmed, as long as the connection to them works (ticket 31)', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await bob.connectedTo('Alice');
  await alice.wire.cut();
  const lost = bob.selectedRoom.locator('li.lost');
  await expect(lost).toContainText('connection to server lost');
  // The end of the 60 s grace period is what used to close a working connection. With the hooks it is run at once, the
  // same code the timer runs; without them (or on a deployed copy older than the hook) the test waits it out.
  const canExpire = await bob.page.evaluate(() => typeof (window as unknown as { __dave?: { expireGrace?: unknown } }).__dave?.expireGrace === 'function');
  if (canExpire) expect(await bob.hook<string>('expireGrace', 'Alice')).toBe('kept');
  else { test.slow(); await bob.page.waitForTimeout(65_000); }
  await expect(lost).toContainText('Alice');
  if (await bob.hasHooks()) await bob.hearing('Alice');
  alice.wire.restore();
  // The next attempt comes after the back-off (client/room.ts): a few seconds here, 15 to 30 s after a minute away.
  await expect(alice.composer).toBeEnabled({ timeout: 35_000 });
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await expect(lost).toHaveCount(0);
  await bob.connectedTo('Alice');
});

test('a stalled connection is rebuilt and comes up again', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  // Trailing candidates of the torn-down connection can reach the new one before its description (seen with TURN on nightly;
  // Firefox logs the error only as an object handle, so the pattern cannot name addIceCandidate).
  for (const f of [alice, bob]) f.expectWarning(/signal handling failed/);
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string) => string } }).__dave.rebuild('Bob'));
  expect(r).toMatch(/^rebuilt Bob/);
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await alice.hearing('Bob');
});

test('after a stalled attempt the rebuild goes through the TURN relay, and both sides take it (ticket 22)', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  for (const f of [alice, bob]) f.expectWarning(/signal handling failed/);
  // One attempt already counted as stalled: what the watchdog does after the first 15 s without a connection.
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string, stalled: number) => string } }).__dave.rebuild('Bob', 1));
  // A local build hands out STUN only (.dev.vars carries a placeholder TURN token), so the policy stays `all` there by design.
  test.skip(r === 'rebuilt Bob, relayOnly=false', 'no TURN server behind this copy: run it against nightly');
  expect(r).toBe('rebuilt Bob, relayOnly=true');
  // Only Alice's side is relay-only, and her relay candidates alone put the pair through the TURN server: Bob reads it too.
  // A relay allocation adds round trips to the TURN server before the first check, so the wait is the watchdog's own 15 s
  // stretched, not the default.
  await expect(alice.badge('Bob')).toHaveText('via relay', { timeout: 45_000 });
  await expect(bob.badge('Alice')).toHaveText('via relay', { timeout: 45_000 });
  expect((await alice.peers()).find((p) => p.name === 'Bob')?.relayOnly).toBe(true);
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});

test('a friend whose server socket drops and comes back while the voice stays up plays no leave or join cue', async ({ crowd }) => {
  // Problem report, 2026-10-08: a friend's app reconnected to the server on its own, the call itself never broke, yet
  // rejoin sounds played.
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob', { picture: '🦊' });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await needHooks(alice);
  // Cues only play on a running AudioContext. Headless Firefox on a runner without a sound device never gets one.
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  test.skip(context !== 'running', `no running AudioContext here (${context}), so no cue can play`);
  await alice.page.waitForTimeout(2000); // the join cues are done
  await alice.cuesPlayed();
  await bob.cuesPlayed();

  // Bob's socket drops and stays away long enough for the Room to tell Alice he is gone, then comes back.
  await bob.wire.cut();
  await expect(bob.banner).toContainText(/Reconnecting|Server unavailable/);
  await expect(alice.selectedRoom.locator('li.lost')).toContainText('connection to server lost');
  bob.wire.restore();
  await bob.connected();
  await expect(bob.banner).toHaveCount(0);
  await expect.poll(() => alice.inCall()).toEqual(['Alice', 'Bob']);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await expect(alice.badge('Bob')).toHaveText('direct');
  await alice.page.waitForTimeout(2000); // a cue set off by the last presence would have played by now

  // The voice never stopped, so nobody left and nobody came back.
  expect(await alice.cuesPlayed(), 'Alice hears no cue for Bob').toEqual([]);
  expect(await bob.cuesPlayed(), 'Bob hears no cue for Alice').toEqual([]);
});

test('a server restart that drops every socket plays no leave or join cue while the call itself stays up', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob', { picture: '🦊' });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await needHooks(alice);
  // Cues only play on a running AudioContext. Headless Firefox on a runner without a sound device never gets one.
  const context = await alice.hook<{ context: string | null }>('playback').then((p) => p.context);
  test.skip(context !== 'running', `no running AudioContext here (${context}), so no cue can play`);
  await expect.poll(async () => (await alice.cuesPlayed()).length + (await bob.cuesPlayed()).length, { message: 'the join cues are done' }).toBe(0);

  // The Room goes away for everyone at once (a deploy restarts it), and the friends come back one after the other. The
  // first presence Alice gets back lists her as a visitor and Bob not at all: her own call is not re-declared yet.
  await Promise.all([alice.wire.cut(), bob.wire.cut()]);
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  await expect(bob.banner).toContainText(/Reconnecting|Server unavailable/);
  const declared = alice.wire.frames('down', 'call').length;
  alice.wire.restore();
  await alice.connected();
  await expect(alice.banner).toHaveCount(0);
  // Alice is back in the call on the server before Bob's socket returns.
  await expect.poll(() => alice.wire.frames('down', 'call').length, { message: 'Alice declares her join again' }).toBeGreaterThan(declared);
  await alice.page.waitForTimeout(2000);
  bob.wire.restore();
  await bob.connected();
  await expect.poll(() => alice.inCall()).toEqual(['Alice', 'Bob']);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await expect(alice.badge('Bob')).toHaveText('direct');
  await bob.page.waitForTimeout(2000); // a cue triggered by the last presence would be playing by now

  // The voice never stopped, so nobody left and nobody came back.
  expect(await alice.cuesPlayed(), 'Alice, back first, hears no cue for Bob').toEqual([]);
  expect(await bob.cuesPlayed(), 'Bob hears no cue for Alice').toEqual([]);
});
