import { expect, test } from './fixtures';

// The server as an adversary. Each friend's socket runs through a proxy the test controls (fixtures.ts), so a test can do
// what a hostile or compromised Worker could do and check that the clients notice.

/** Flips one hex digit of every DTLS fingerprint in a relayed offer or answer: what a man in the middle has to do. */
const swapFingerprints = (frame: string): string | null => {
  const m = JSON.parse(frame) as { t: string; data?: { description?: { sdp?: string } } };
  const sdp = m.t === 'signal' ? m.data?.description?.sdp : undefined;
  if (!sdp) return frame;
  m.data!.description!.sdp = sdp.replace(/(a=fingerprint:\S+ )([0-9A-F])/gi, (_, head: string, c: string) => head + (c.toUpperCase() === 'A' ? 'B' : 'A'));
  return JSON.stringify(m);
};

test('ADR 0004: a server that swaps DTLS fingerprints cannot get a call connected', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  bob.wire.down = swapFingerprints; // every description reaching Bob is tampered with
  bob.expectWarning(/description rejected: bad signature/);
  // The candidates behind a refused description have no remote description to go with; Firefox also says ICE failed.
  bob.expectWarning(/signal handling failed|ICE failed/);
  alice.expectWarning(/.*/); // Alice sees her attempts stall; the watchdog's retries are the expected outcome
  await alice.join();
  await bob.join();
  await expect.poll(() => bob.problems.some((p) => p.includes('description rejected: bad signature'))).toBe(true);
  // Give the watchdog time for a rebuild or two: it must never come up.
  await bob.page.waitForTimeout(20_000);
  await expect(bob.badge('Alice')).not.toHaveText(/direct|via relay/);
  await expect(alice.badge('Bob')).not.toHaveText(/direct|via relay/);
});

test('ADR 0004: a description with its signature stripped is refused', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  bob.wire.down = (frame) => {
    const m = JSON.parse(frame) as { t: string; data?: { sig?: string } };
    if (m.t === 'signal' && m.data?.sig) delete m.data.sig;
    return JSON.stringify(m);
  };
  bob.expectWarning(/description rejected: unsigned/);
  bob.expectWarning(/signal handling failed|ICE failed/);
  alice.expectWarning(/.*/);
  await alice.join();
  await bob.join();
  await expect.poll(() => bob.problems.some((p) => p.includes('description rejected: unsigned'))).toBe(true);
  await expect(bob.badge('Alice')).not.toHaveText(/direct|via relay/);
});

test('the shared secret never crosses the wire', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.say('hi');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  for (const f of [alice, bob]) {
    expect(f.wire.log.length).toBeGreaterThan(0);
    expect(f.wire.log.filter((l) => l.frame.includes(crowd.room.secret))).toEqual([]);
  }
});

// ADR 0005: texts travel sealed with a key the server never has, and signed by their writer inside.

test('ADR 0005: the server never sees a text in plain, on its way in or out', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.say('meet at the old oak');
  await expect.poll(() => bob.chatTexts()).toEqual(['meet at the old oak']);
  for (const f of [alice, bob]) expect(f.wire.log.filter((l) => l.frame.includes('old oak'))).toEqual([]);
  expect(alice.wire.frames('up', 'sealed')).toHaveLength(1);
});

test('ADR 0005: a text the server passes off as from another friend, or tampers with, is not shown', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  const carolIs = carol.wire.frames<{ you: { publicKey: string; fingerprint: string; name: string } }>('down', 'welcome')[0]!.you;
  bob.expectWarning(/text rejected: (bad signature|unreadable)/);
  let tamper: (m: { from: { publicKey: string; fingerprint: string; name: string }; sealed: string }) => void = (m) => {
    m.from = { publicKey: carolIs.publicKey, fingerprint: carolIs.fingerprint, name: carolIs.name };
  };
  bob.wire.down = (frame) => {
    if (!frame.includes('"t":"sealed"')) return frame;
    const m = JSON.parse(frame) as Parameters<typeof tamper>[0];
    tamper(m);
    return JSON.stringify(m);
  };
  await alice.say('from Alice, says the server: Carol');
  await expect.poll(() => bob.problems.some((p) => p.includes('text rejected: bad signature'))).toBe(true);
  tamper = (m) => { m.sealed = (m.sealed[0] === 'A' ? 'B' : 'A') + m.sealed.slice(1); };
  await alice.say('from Alice, changed on the way');
  await expect.poll(() => bob.problems.some((p) => p.includes('text rejected: unreadable'))).toBe(true);
  bob.wire.down = null;
  await alice.say('untouched');
  await expect.poll(() => bob.chatTexts()).toEqual(['untouched']);
  expect(await carol.chatTexts()).toEqual(['from Alice, says the server: Carol', 'from Alice, changed on the way', 'untouched']);
});

test('ADR 0005: a plain text, as an app from before sends one, is refused as out of date and reaches nobody', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  alice.wire.up = (frame) => {
    if (!frame.includes('"t":"sealed"')) return frame;
    const { id } = JSON.parse(frame) as { id: string };
    return JSON.stringify({ t: 'text', text: 'in plain', id });
  };
  await alice.composer.fill('in plain');
  await alice.composer.press('Enter');
  await expect(alice.page.locator('.chat-log .msg-sys').last()).toContainText('Not sent: this app is out of date, reload the page to send.');
  expect(await alice.pendingTexts()).toEqual([]);
  alice.wire.up = null;
  await alice.say('sealed');
  await expect.poll(() => bob.chatTexts()).toEqual(['sealed']);
});
