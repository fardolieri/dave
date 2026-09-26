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
