import { expect, needHooks, newSecret, test, type Friend } from './fixtures';

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

test('a frame on its way to the server as it goes away is lost with the socket, and nothing is written to it closing', async ({ crowd }) => {
  // CI, 2026-10-11 (the test above, Chromium, run 38162513698): "WebSocket is already in CLOSING or CLOSED state." in
  // Alice's console. The app never writes to a socket that is not open; the wire did: `cut` closes the browser's socket to
  // the server first and Alice's side of it after, and a frame of hers that reached the wire in between was still passed
  // on to the closing socket. Here her frame reaches the wire the moment the cut begins. The browser's socket is closing
  // only until the server answers its close, which on a local build can come before the frame: one try caught it on the
  // first run and missed it on the retry, so the test tries five times. Firefox writes nothing to its console for it.
  const alice = await crowd.open('Alice');
  await alice.connected();
  for (let i = 0; i < 5; i++) {
    let cutting: Promise<void> | null = null;
    alice.wire.up = (frame) => {
      if (!cutting && frame.includes('"t":"sealed"')) cutting = alice.wire.cut();
      return frame;
    };
    await alice.composer.fill(`on its way ${i}`);
    await alice.composer.press('Enter');
    await expect.poll(() => cutting !== null, { message: 'the text reaches the wire' }).toBe(true);
    await cutting;
    await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
    alice.wire.up = null;
    alice.wire.restore();
    await alice.connected();
    await expect(alice.banner).toHaveCount(0);
  }
});

test('a join lost with a socket that drops is asked again on the next one, and the call starts', async ({ crowd }) => {
  // PR #44's preview, 2026-10-11 (call.spec.ts "Chromium and Firefox in one call…", Chromium, run 38180213444, attempt 1):
  // "The server did not answer the join request." Chris's join went out and his socket dropped before the answer; the
  // server never let him in (nobody saw him in the call), and it let his next socket in a second later. Nothing asked
  // again: eight seconds after the click the app gave up on a server that was there (ticket 47). Here the server never
  // gets Alice's join, as it never got Chris's, and her socket comes back at once.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await bob.join();
  let cutting: Promise<void> | null = null;
  alice.wire.up = (frame) => {
    if (cutting || !frame.includes('"t":"join"')) return frame;
    cutting = alice.wire.cut().then(() => alice.wire.restore());
    return null;
  };
  await alice.join();
  expect(cutting, 'the join reached the wire and was lost').not.toBeNull();
  await expect(alice.selectedRoom.getByText('did not answer')).toHaveCount(0);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
});

test('a join asked again after a reconnect and left unanswered is not asked once more for the next join', async ({ crowd }) => {
  // Grumpy Friend, PR #46 (ticket 47): in the call on bad Wi-Fi, Alice's socket drops and the join she declares again on
  // the next one gets no answer. She presses Leave, then Join, and her microphone takes its time to open. If her socket
  // drops once more meanwhile, the old declaration must not be asked again: it would put her in the call before her own
  // join, with her button still at Join.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  alice.wire.down = (frame) => (frame.includes('"t":"call"') ? null : frame); // the answer to her declaration never comes
  const declared = alice.wire.frames('up', 'join').length;
  await alice.wire.cut();
  alice.wire.restore();
  await expect.poll(() => alice.wire.frames('up', 'join').length, { message: 'she declares her join on the new socket' }).toBe(declared + 1);
  await alice.leave();
  alice.wire.down = null;
  await alice.page.evaluate(() => { // a slow permission prompt: the microphone opens only when the test says so
    const md = navigator.mediaDevices;
    const open = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => new Promise((resolve) => { (window as unknown as { micGo: () => void }).micGo = () => resolve(open(c)); });
  });
  await alice.selectedRoom.locator('button.join').click();
  await expect.poll(() => alice.page.evaluate(() => typeof (window as unknown as { micGo?: unknown }).micGo)).toBe('function');
  const atClick = alice.wire.frames('up', 'join').length;
  const welcomes = alice.wire.frames('down', 'welcome').length;
  await alice.wire.cut();
  alice.wire.restore();
  await expect.poll(() => alice.wire.frames('down', 'welcome').length).toBeGreaterThan(welcomes);
  await alice.connected();
  await alice.page.waitForTimeout(1000); // what the old declaration would send, it sends on the welcome
  expect(alice.wire.frames('up', 'join').length, 'no join before her microphone is open').toBe(atClick);
  await alice.page.evaluate(() => (window as unknown as { micGo: () => void }).micGo());
  await expect(alice.selectedRoom.locator('button.leave')).toBeVisible();
  expect(alice.wire.frames('up', 'join').length, 'one join for one click').toBe(atClick + 1);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await alice.connectedTo('Bob');
});

test('joining another room\'s call while a join waits for its answer leaves that join: one call, and nothing goes to the room left', async ({ crowd }) => {
  // Ticket 47, left for Daniel: Alice clicks Join in Room, and its answer is slow (the Room mints TURN credentials first,
  // up to 5 s). Meanwhile she joins the call in Other. Joining there left only a call already joined, not one still
  // waiting: Room's server already had her in its call, and its answer, when it came, put her in that call too, her
  // microphone with it, in a room she thinks she left.
  const other = { secret: newSecret(), name: 'Other' };
  const bob = await crowd.open('Bob', { rooms: [crowd.room, other] });
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  await bob.join();
  const held: Array<() => void> = [];
  alice.wire.down = (frame, pass) => {
    if (held.length || !frame.includes('"t":"call"')) return frame;
    held.push(() => pass(frame));
    return null;
  };
  await alice.selectedRoom.locator('button.join').click();
  await expect.poll(() => held.length, { message: 'Room answers her join, and the answer is held' }).toBe(1);
  await alice.selectRoom('Other');
  await alice.join();
  held[0]!();
  await alice.page.waitForTimeout(3000); // what the late answer would start, it starts at once: the call, then an offer to Bob
  await expect(alice.page.locator('button.leave'), 'she is in one call').toHaveCount(1);
  await expect(alice.selectedRoom.locator('button.leave')).toBeVisible();
  await expect.poll(() => bob.inCall(), { message: 'Room\'s server has her out of its call' }).toEqual(['Bob']);
  expect((await bob.peers()).map((p) => p.name), 'no connection to Bob, so no voice of hers in Room').toEqual([]);
  await bob.selectRoom('Other');
  await expect.poll(() => bob.inCall(), { message: 'Other\'s server has her in its call' }).toEqual(['Alice']);
});

test('a late answer to a join declared again is not taken for the answer to the next join', async ({ crowd }) => {
  // Ticket 47, left for Daniel: answers were matched to requests by their kind alone. In the call, Alice's socket drops
  // and she declares her join again on the next one; that answer is slow (a TURN mint). She leaves and joins again, and
  // the old answer, arriving first, was taken for the new join's: her join sequence was then not the one the server
  // listed for her, so who offers to whom could disagree.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await needHooks(alice);
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  const held: Array<() => void> = [];
  alice.wire.down = (frame, pass) => {
    if (!frame.includes('"t":"call"')) return frame;
    held.push(() => pass(frame));
    return null;
  };
  await alice.wire.cut();
  alice.wire.restore();
  await expect.poll(() => held.length, { message: 'the server answers her declaration on the new socket' }).toBe(1);
  await alice.leave();
  // Bob leaves and joins again meanwhile: the server's next join sequence moves on, so the two answers differ.
  await bob.leave();
  await bob.join();
  await alice.selectedRoom.locator('button.join').click();
  await expect.poll(() => held.length, { message: 'the server answers her new join' }).toBe(2);
  alice.wire.down = null;
  for (const pass of held) pass(); // the old answer first, as a declaration's slow TURN mint would send them
  await expect(alice.selectedRoom.locator('button.leave')).toBeVisible();
  type State = { myJoinSeq: number | null; participants: string[] };
  await expect.poll(async () => { const s = await alice.hook<State>('state'); return s.participants.includes(`Alice#${s.myJoinSeq}`); }, { message: 'her join sequence is the one the server lists' }).toBe(true);
  await alice.connectedTo('Bob');
});

test('Join in Room, then in Other, then in Room again while the microphone opens ends in Room\'s call', async ({ crowd }) => {
  // Grumpy Friend, PR #48: on a phone the microphone takes its time (Firefox asks on every visit). Joining Other left
  // Room's join still opening the microphone, and her next Join in Room found that join under way and did nothing:
  // once the microphone opened, both joins ended, and she was in no call, her last click for Room.
  const other = { secret: newSecret(), name: 'Other' };
  const bob = await crowd.open('Bob', { rooms: [crowd.room, other] });
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other], connect: false });
  await alice.context.addInitScript(() => { // each request for the microphone waits until the test lets it go
    const w = window as unknown as { __mic: Array<() => void> };
    w.__mic = [];
    const md = navigator.mediaDevices;
    const open = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => new Promise((resolve, reject) => { w.__mic.push(() => open(c).then(resolve, reject)); });
  });
  await alice.open();
  await bob.join();
  const asked = () => alice.page.evaluate(() => (window as unknown as { __mic: unknown[] }).__mic.length);
  await alice.selectedRoom.locator('button.join').click();
  await expect.poll(asked, { message: 'Room asks for the microphone' }).toBe(1);
  await alice.selectRoom('Other');
  await alice.selectedRoom.locator('button.join').click();
  await expect.poll(asked, { message: 'Other asks for the microphone' }).toBe(2);
  await alice.selectRoom('Room');
  await alice.selectedRoom.locator('button.join').click(); // Room after all
  await alice.page.evaluate(() => { for (const go of (window as unknown as { __mic: Array<() => void> }).__mic.splice(0)) go(); });
  await expect(alice.selectedRoom.locator('button.leave'), 'her last click wins').toBeVisible();
  await expect(alice.page.locator('button.leave'), 'she is in one call').toHaveCount(1);
  await expect.poll(() => bob.inCall(), { message: 'Room\'s server has her in its call' }).toEqual(['Bob', 'Alice']);
  await bob.selectRoom('Other');
  await expect.poll(() => bob.inCall(), { message: 'and Other\'s has her out of its call' }).toEqual([]);
});

test('a Rejoin left for another room\'s call is not taken up by the next reload', async ({ crowd }) => {
  // Grumpy Friend, PR #48: in Room's call, Alice reloads and the Rejoin starts; she joins Other instead, which leaves the
  // Rejoin. Her Wi-Fi loses Other's answer, so she reloads again, within the Rejoin window. Leaving the Rejoin kept its
  // marker, and the reload put her back in Room's call without a click, her microphone with it.
  const other = { secret: newSecret(), name: 'Other' };
  const bob = await crowd.open('Bob', { rooms: [crowd.room, other] });
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  await bob.join();
  await alice.join();
  await alice.connectedTo('Bob');
  alice.wire.down = (frame) => (frame.includes('"t":"call"') ? null : frame); // every answer to a join is lost from here on
  const joins = () => alice.wire.frames('up', 'join').length;
  const before = joins();
  await alice.page.reload(); // the marker names Room
  await alice.connected();
  await expect.poll(joins, { message: 'the Rejoin asks Room' }).toBeGreaterThan(before);
  await alice.selectRoom('Other');
  await alice.selectedRoom.locator('button.join').click();
  await expect(alice.selectedRoom.locator('.warn', { hasText: 'The server did not answer' })).toBeVisible({ timeout: 15_000 });
  alice.wire.down = null;
  const asked = joins();
  await alice.page.reload(); // well inside the marker's 30 s
  await alice.connected();
  await alice.page.waitForTimeout(3000); // a Rejoin asks as soon as Room's socket is let in
  expect(joins(), 'no Rejoin').toBe(asked);
  await expect(alice.page.locator('button.leave'), 'she is in no call').toHaveCount(0);
  await expect.poll(() => bob.inCall(), { message: 'Room\'s server has her out of its call' }).toEqual(['Bob']);
});

test('a socket the server never answers is given up and tried again, and the room connects', async ({ crowd }) => {
  // Nightly e2e, 2026-10-12 (share.spec.ts, Chromium, run 38219476267): Alice's first socket heard no challenge for 20 s and
  // she stayed on "Connecting…", with nothing in the app to end the wait (ticket 48). Here her first socket is never answered.
  const alice = await crowd.open('Alice', { connect: false });
  alice.wire.unanswered = 1;
  await alice.open();
  await expect(alice.banner).toHaveCount(0);
});

test('an app script cut off on the first load is loaded again, and the room connects', async ({ crowd }) => {
  // Preview run of PR #72, 2026-10-16 (presence.spec.ts, Chromium, run 38939823521): the connection was reset under the
  // app's script, nothing ran, and Alice's page stayed empty (ticket 58). Here the first fetch of the script is reset.
  const alice = await crowd.open('Alice', { connect: false });
  alice.expectWarning(/Failed to load resource: net::ERR_CONNECTION_RESET|Loading failed for the module with source/);
  // Firefox names a page that reloads itself before any click a bounce tracker; it would clear the site's storage only if
  // no click followed within the hour, and a friend using the app clicks.
  alice.expectWarning(/has been classified as a bounce tracker/);
  let cut = 0;
  await alice.page.route(/\/(assets\/index-[^/]*\.js|src\/client\/index\.tsx)$/, (r) => (cut++ ? r.continue() : r.abort('connectionreset')));
  await alice.open();
  expect(cut).toBe(2);
});

test('a page whose app script went with a deploy loads again, onto the new one', async ({ crowd }) => {
  // A page from before a deploy asks for a script the deploy removed, and the single-page fallback answers with
  // index.html (wrangler.jsonc): a module of the wrong type, which runs nothing, like a script cut off (ticket 58).
  const alice = await crowd.open('Alice', { connect: false });
  alice.expectWarning(/MIME type|Loading failed for the module with source/);
  alice.expectWarning(/has been classified as a bounce tracker/);
  let served = 0;
  await alice.page.route(/\/(assets\/index-[^/]*\.js|src\/client\/index\.tsx)$/, (r) =>
    (served++ ? r.continue() : r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' })));
  await alice.open();
  expect(served).toBe(2);
});

test('a page opened while a deploy rolls out keeps loading again until its app script is there', async ({ crowd }) => {
  // Nightly e2e of c3934c2, 2026-10-26 (run 40392826988): for about a minute after the deploy the edge answered the app's
  // script with a 404, on the reload too, and pages stayed empty (ticket 64). Here the script is missing for two loads.
  const alice = await crowd.open('Alice', { connect: false });
  alice.expectWarning(/the server responded with a status of 404|Loading failed for the module with source/);
  alice.expectWarning(/has been classified as a bounce tracker/);
  let served = 0;
  await alice.page.route(/\/(assets\/index-[^/]*\.js|src\/client\/index\.tsx)$/, (r) =>
    (served++ > 1 ? r.continue() : r.fulfill({ status: 404, body: '' })));
  await alice.open();
  expect(served).toBe(3);
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

test('an offer made while my socket comes back goes out once I am in the call again, and only then', async ({ crowd }) => {
  // Nightly, 2026-10-10 (the two tests above, Firefox): "dropped signal not in the call" in Alice's console. A socket that
  // comes back is open before the server has let her in, and she is a visitor to it until her join: a signal written
  // meanwhile reaches the server as a visitor's and is refused.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  const ufrag = (await peerOf(bob))?.remoteUfrag;

  // What the server says to Alice from its welcome on is held at the wire: her new socket is open, the server has let her
  // in, she does not know yet. Her connection to Bob restarts ICE meanwhile, as it does by itself when the path falters.
  const held: string[] = [];
  alice.wire.down = (frame) => (frame.includes('"t":"welcome"') || held.length > 0 ? (held.push(frame), null) : frame);
  await alice.wire.cut();
  alice.wire.restore();
  await expect.poll(() => held.length, { message: 'the server lets Alice in again' }).toBeGreaterThan(0);
  await alice.hook('restartIce', 'Bob');
  await expect.poll(async () => (await peerOf(alice))?.signaling, { message: 'Alice makes the offer' }).toBe('have-local-offer');
  await alice.page.waitForTimeout(500); // an offer is signed before it goes out: time for it to go, if it goes
  alice.wire.down = null;
  for (const f of held) alice.wire.deliver(f);
  await alice.connected();

  await expect.poll(async () => (await peerOf(bob))?.remoteUfrag, { message: "Bob holds Alice's credentials from the restart" }).not.toBe(ufrag);
  await expect.poll(async () => (await peerOf(alice))?.signaling, { message: 'Alice got the answer' }).toBe('stable');
  await alice.hearing('Bob');
  await bob.hearing('Alice');
});

test('a share stopped from the browser while my socket comes back, before the server has let me in, does not get me refused', async ({ crowd, browserName }) => {
  // Review of the fix above: signals waited for the welcome, the rest did not. The room's buttons are frozen meanwhile, but
  // the browser's own "stop sharing" control is not, and the frame it sends reached the server before the answer to its
  // challenge: a stranger's frame, whose error the room took for a wrong invite link, refused until a reload.
  test.skip(browserName !== 'chromium', 'the sharer is Chromium (its fake screen capture needs no picker); one run is enough');
  const alice = await crowd.open('Alice', { engine: 'chromium' });
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  await alice.startShare();
  // Her new socket is open, her answer to the challenge not yet given (a cheap phone still signing it).
  let challenge: string | null = null;
  alice.wire.down = (frame) => (challenge === null && frame.includes('"t":"challenge"') ? ((challenge = frame), null) : frame);
  await alice.wire.cut();
  alice.wire.restore();
  await expect.poll(() => challenge, { message: "Alice's socket is open again" }).not.toBeNull();
  expect(await alice.hook('endShare')).toBe('ended');
  await alice.page.waitForTimeout(300); // time for the frame to go up, if it goes
  alice.wire.down = null;
  alice.wire.deliver(challenge!);
  await alice.connected();
  await expect(alice.banner).toHaveCount(0);
  await expect(alice.button('Share screen')).toBeVisible();
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
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
  // Her face stays in the title too, as long as her voice comes through, after Bob's own, as the list has them.
  await expect(bob.page).toHaveTitle(/^(🔘|⚪) dave 𝗕𝗔$/u);
  if (await bob.hasHooks()) await bob.hearing('Alice');
  alice.wire.restore();
  // The next attempt comes after the back-off (client/room.ts): a few seconds here, 15 to 30 s after a minute away.
  await alice.connected(35_000);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
  await expect(lost).toHaveCount(0);
  await expect(bob.page).toHaveTitle(/^(🔘|⚪) dave 𝗕𝗔$/u);
  await expect(alice.page).toHaveTitle(/^(🔘|⚪) dave 𝗔𝗕$/u); // my own face first, though Alice joined again after Bob
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
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string) => Promise<string> } }).__dave.rebuild('Bob'));
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
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string, stalled: number) => Promise<string> } }).__dave.rebuild('Bob', 1));
  // A local build hands out STUN only (.dev.vars carries a placeholder TURN token), so the policy stays `all` there by design.
  test.skip(r === 'rebuilt Bob, relayOnly=false', 'no TURN server behind this copy: run it against a preview');
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

test('a relay-only rebuild whose ICE failed comes back with voice both ways (ticket 63)', async ({ crowd, browserName }) => {
  // Nightly e2e of 3c5faba, 2026-10-25 (run 40239237252), and the preview of PR #89, 2026-10-21 (run 39566936449), both
  // Firefox: the relay-only rebuild of the test above failed ICE after 5 s, the app restarted ICE, and the restart connected
  // through the relay on both sides. Alice heard Bob, Bob got not one byte of Alice's voice. Here Bob's candidates are kept
  // from Alice until her rebuilt connection fails, which takes it down the same path.
  // Chromium never fails a connection that has no remote candidate: it waits, and the watchdog rebuilds it (the test above).
  test.skip(browserName !== 'firefox', 'only Firefox fails ICE with no candidate from the other side');
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  for (const f of [alice, bob]) f.expectWarning(/signal handling failed|WebRTC: ICE failed/);
  type Ice = { name: string; ice: string; generation: number; relayOnly: boolean };
  const iceOf = async () => (await alice.hook<Ice[]>('peers')).find((p) => p.name === 'Bob');
  const before = (await iceOf())!.generation;
  alice.wire.down = (frame) => (frame.includes('"t":"signal"') && frame.includes('"candidates":') ? null : frame);
  const r = await alice.page.evaluate(() => (window as unknown as { __dave: { rebuild: (n: string, stalled: number) => Promise<string> } }).__dave.rebuild('Bob', 1));
  test.skip(r === 'rebuilt Bob, relayOnly=false', 'no TURN server behind this copy: run it against a preview');
  expect(r).toBe('rebuilt Bob, relayOnly=true');
  await expect.poll(async () => { const p = await iceOf(); return p && p.generation > before ? p.ice : 'old'; }, { message: "Alice's relay-only attempt fails ICE", timeout: 45_000 }).toBe('failed');
  alice.wire.down = null;
  await expect(alice.badge('Bob')).toHaveText('via relay', { timeout: 45_000 });
  await expect(bob.badge('Alice')).toHaveText('via relay', { timeout: 45_000 });
  await alice.hearing('Bob');
  await bob.hearing('Alice');
  // Rebuilt on the side that failed, never restarted: Alice's or Bob's, the connection that carries the call had no restart.
  for (const f of [alice, bob]) expect((await f.hook<Array<{ iceRestarts: number }>>('peers'))[0]?.iceRestarts, `${f.name}'s connection was never restarted`).toBe(0);
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

test('a friend whose server socket drops and comes back plays no join cue for a friend in the room but out of the call', async ({ crowd }) => {
  // Problem report, 2026-10-28: a friend in the room but out of the call heard a join cue, joined, and was told by the
  // friends in the call that none of them had left or come back. The fix for the report of Oct 8 keeps a friend whose
  // socket drops in the call only while I hold a connection to them, and out of the call I hold none.
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob', { picture: '🦊' });
  const carol = await crowd.open('Carol', { picture: '🐙' });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  await expect.poll(() => carol.inCall()).toEqual(['Alice', 'Bob']);
  await needHooks(carol);
  // Out of the call, Carol's cues start on her first gesture, as anyone's do who has clicked into the page.
  await carol.composer.click();
  // Cues only play on a running AudioContext. Headless Firefox on a runner without a sound device never gets one.
  await expect.poll(() => carol.hook<{ cues: string | null }>('playback').then((p) => p.cues), { timeout: 3000 }).toBe('running').catch(() => {});
  const cues = await carol.hook<{ cues: string | null }>('playback').then((p) => p.cues);
  test.skip(cues !== 'running', `no running AudioContext for cues here (${cues}), so no cue can play`);
  await expect.poll(async () => (await carol.cuesPlayed()).length, { message: 'the join cues are done' }).toBe(0);
  await carol.page.waitForTimeout(2000);
  await carol.cuesPlayed();

  // Bob's socket drops and stays away long enough for the Room to tell the others he is gone, then comes back.
  await bob.wire.cut();
  await expect(bob.banner).toContainText(/Reconnecting|Server unavailable/);
  await expect(alice.selectedRoom.locator('li.lost')).toContainText('connection to server lost');
  bob.wire.restore();
  await bob.connected();
  await expect(bob.banner).toHaveCount(0);
  await expect.poll(() => alice.inCall()).toEqual(['Alice', 'Bob']);
  await expect.poll(() => carol.inCall()).toEqual(['Alice', 'Bob']);
  await expect(alice.badge('Bob')).toHaveText('direct');
  await carol.page.waitForTimeout(2000); // a cue set off by the last presence would have played by now

  // Bob never left the call: Carol, listening from outside it, hears nobody come back.
  expect(await carol.cuesPlayed(), 'Carol hears no cue for Bob').toEqual([]);
});

test('a call whose audio device fails under it plays again: the friends\' voices and the cues', async ({ crowd }) => {
  // Soak issues #39, #49, #50, #51: Chromium logged "The AudioContext encountered an error from the audio device or the
  // WebAudio renderer." It then stops that context and leaves it "suspended", and nothing in the app started it again:
  // the friends' voices, which play through the call's context, or the cues stayed silent until a reload. The hook
  // fails both contexts the way Chromium does.
  const alice = await crowd.open('Alice', { picture: '😀' });
  const bob = await crowd.open('Bob', { picture: '🦊' });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type Playback = { context: string | null; clock: number | null; cues: string | null; blocked: boolean };
  const playback = () => alice.hook<Playback>('playback');
  // Headless Firefox on a runner without a sound device never gets a running AudioContext: nothing to fail.
  const before = await playback();
  test.skip(before.context !== 'running' || before.cues !== 'running', `no running AudioContexts here (call ${before.context}, cues ${before.cues})`);
  await expect.poll(async () => (await alice.cuesPlayed()).length + (await bob.cuesPlayed()).length, { message: 'the join cues are done' }).toBe(0);

  expect(await alice.hook('failAudio', 'call')).toBe('failed');
  expect(await alice.hook('failAudio', 'cues')).toBe('failed');

  // The call's context runs again without a click, and its clock moves: Bob's voice plays through it.
  await expect.poll(async () => (await playback()).context, { message: 'the call\'s context runs again' }).toBe('running');
  const clock = (await playback()).clock!;
  await expect.poll(async () => (await playback()).clock!, { message: 'the call\'s context renders' }).toBeGreaterThan(clock + 0.5);
  expect((await playback()).blocked, 'no "Click to hear the call" was needed').toBe(false);
  // And the cues: Bob's leave plays one for Alice.
  await expect.poll(async () => (await playback()).cues, { message: 'the cues\' context runs again' }).toBe('running');
  await bob.leave();
  await expect.poll(async () => (await alice.cuesPlayed()).length, { message: 'Alice hears Bob leave' }).toBeGreaterThan(0);
});

test('a call context the audio device failed for good while I was out of the call plays when I join again', async ({ crowd }) => {
  // Review of the fix above: the call's context outlives a Leave. Failing again and again while nobody is in the call,
  // it gives up with no "Click to hear the call" to show, and the next Join started it with a plain resume(), which a
  // context in that state ignores (probe run 38597053278): a call with no sound and nothing to click.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await needHooks(alice);
  type Playback = { context: string | null; blocked: boolean };
  const playback = () => alice.hook<Playback>('playback');
  const before = await playback();
  test.skip(before.context !== 'running', `no running AudioContext here (${before.context})`);
  await alice.leave();
  alice.expectWarning(/^warning: \[audio\] the call AudioContext stopped after \d+ failures/);
  for (let i = 0; i < 5; i++) expect(await alice.hook('failAudio', 'call', true)).toBe('failed');
  await expect.poll(async () => (await playback()).context, { message: 'the call\'s context gave up' }).toBe('suspended');

  await alice.join();
  await alice.connectedTo('Bob');
  await expect.poll(async () => (await playback()).context, { message: 'the call\'s context runs at the join' }).toBe('running');
  await alice.hearing('Bob');
});

// Oct 2026, ticket 54: the network can cut a socket with no close reaching either end. The browser then took it for open
// for good: nothing waited for the answer to its ping, a text went into it and nowhere else, and the app said all was well.
test('regression: a socket gone silent without a close is given up, and the text written into it arrives once', async ({ crowd }) => {
  test.slow(); // the app waits for two unanswered pings, 30 s apart, before it gives the socket up
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const start = Date.now();
  alice.wire.sever();
  await alice.composer.fill('into the silence');
  await alice.composer.press('Enter');
  const gaveUp = () => alice.wire.closes.filter((c) => c.side === 'page').map((c) => c.code);
  await expect.poll(gaveUp, { message: 'Alice gives the silent socket up herself', timeout: 150_000 }).toEqual([4009]);
  await alice.connected();
  // The Room took it on the new socket, once: it came back to her, and no longer waits.
  await expect.poll(() => alice.pendingTexts(), { message: 'the text arrives on the socket that replaced the silent one' }).toEqual([]);
  expect(await alice.chatTexts()).toEqual(['into the silence']);
  // Sent again once: into the silence, then on the new socket. Only the frames tell: the app shows a text of an id once.
  expect(alice.wire.log.filter((f) => f.dir === 'up' && f.frame.startsWith('{"t":"sealed"')), 'Alice sent it twice, once per socket').toHaveLength(2);
  // Bob gets it, once, unless the network dropped his own socket meanwhile (nightly, 2026-10-16: 0.6 s after Alice's new
  // socket came in, ticket 57). The Room keeps no texts, so one sent while his socket was down is not his to get. His wire
  // can hear of the drop after Alice has the text back, so the drop is looked for all the while.
  await expect.poll(async () => (bob.wire.droppedSince(start) ? 'dropped' : (await bob.chatTexts()).join('|')), { message: 'Bob gets the text, or his socket dropped' })
    .toMatch(/^(dropped|into the silence)$/);
  if (bob.wire.droppedSince(start)) {
    await bob.connected();
    expect([[], ['into the silence']], 'Bob has it once, or not at all').toContainEqual(await bob.chatTexts());
    return;
  }
  expect(await bob.chatTexts()).toEqual(['into the silence']);
  expect(bob.wire.log.filter((f) => f.dir === 'down' && f.frame.startsWith('{"t":"sealed"')), 'the Room passed it on to Bob once').toHaveLength(1);
});

test('a socket the browser could not open, tried again until one gets in, fails no test on the browser\'s own error line', async ({ crowd, browserName }) => {
  // A preview, 2026-10-21 (ticket 60), Chromium: a room socket's upgrade was reset on the way to Cloudflare, the app gave
  // that socket up and the next one got in, and the test failed on the line Chromium logs for the failed upgrade alone.
  // Ticket 55's upgrades answered 500 the same way. Here the browser is offline while the app reconnects: its attempts fail
  // in the browser as those did, until it is back online and one gets in.
  const alice = await crowd.open('Alice');
  await alice.context.setOffline(true);
  await alice.wire.cut();
  alice.wire.restore();
  await expect(alice.banner).toContainText(/Reconnecting|Server unavailable/);
  if (browserName === 'chromium') {
    await expect.poll(() => alice.problems.some((p) => /WebSocket connection to '[^']*\/ws\/[^']*' failed/.test(p)), 'an attempt failed in the browser').toBe(true);
  }
  await alice.context.setOffline(false);
  await alice.connected(35_000);
});
