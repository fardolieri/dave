import { expect, needHooks, test, type Friend } from './fixtures';

// The invariant watchdog (quality ticket 04). Every other test checks that it stays quiet in a normal call: its `[invariant]`
// warnings fail a test like any other warning (fixtures.ts). Here each invariant is broken on purpose through the inspection
// hooks, and must be reported. The sharer is Chromium, as in share.spec.ts: its fake screen capture needs no picker.

/** Alice and Bob in a call, connected both ways; Alice in Chromium when she is to share. */
async function pair(crowd: { open: (n: string, o?: object) => Promise<Friend> }, aliceShares = false): Promise<[Friend, Friend]> {
  const alice = await crowd.open('Alice', aliceShares ? { engine: 'chromium' } : {});
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.connectedTo('Alice');
  return [alice, bob];
}
const fired = (f: Friend) => async () => (await f.invariants()).map((v) => v.kind);
/** The longest grace period (core/invariants.ts), two readings and some slack. */
const REPORTED_WITHIN = 30_000;

test('a share tile left on "Opening…" while its video decodes is reported (share_opening)', async ({ crowd }) => {
  const [alice, bob] = await pair(crowd, true);
  await needHooks(bob);
  await alice.startShare();
  await bob.watchShare('Alice');
  expect(await bob.invariants()).toEqual([]);
  bob.expectInvariant('share_opening');
  // What the problem report of Oct 3 saw: the share's frames arrive, the tile never turns live.
  expect(await bob.hook('holdOpening', 'Alice')).toBe('holding');
  await expect(bob.tile('Alice')).toHaveClass(/share-opening/);
  expect(await bob.receivingShareFrom('Alice')).toBe(true);
  await expect.poll(fired(bob), { timeout: REPORTED_WITHIN }).toEqual(['share_opening']);
  const [report] = await bob.invariants();
  expect(report!.heldMs).toBeGreaterThanOrEqual(10_000);
  expect(report!.snapshot).toMatchObject({ peer: { watching: true, shareLive: false, sharing: true } });
  expect(JSON.stringify(report!.snapshot)).not.toContain('Alice'); // no names
});

test('a gain off what the volume controls say is reported, voice and share apart (voice_gain, share_gain)', async ({ crowd }) => {
  const [alice] = await pair(crowd);
  await needHooks(alice);
  alice.expectInvariant('share_gain');
  alice.expectInvariant('voice_gain');
  // The share's sound silenced while its volume control says 100 %: what a slider wired to the wrong gain does.
  await expect.poll(() => alice.hook('detuneGain', 'Bob', 'share', 0)).toBe('detuned');
  await expect.poll(fired(alice), { timeout: REPORTED_WITHIN }).toEqual(['share_gain']);
  await expect.poll(() => alice.hook('detuneGain', 'Bob', 'voice', 0.5)).toBe('detuned');
  await expect.poll(fired(alice), { timeout: REPORTED_WITHIN }).toEqual(['share_gain', 'voice_gain']);
  // The report says which gain is off and by how much, not how loud Alice set Bob, and never next to his fingerprint.
  const [share] = await alice.invariants();
  expect(share!.snapshot['peer']).toMatchObject({ shareGain: 0, shareGainExpected: 1 });
  expect(share!.snapshot['peer']).not.toHaveProperty('fingerprint');
  expect(share!.snapshot['peer']).not.toHaveProperty('volume');
  // Once per kind per call: the share gain is still off, and not reported again.
  await alice.page.waitForTimeout(8_000);
  expect(await fired(alice)()).toEqual(['share_gain', 'voice_gain']);
});

test('a badge left on "direct" or "via relay" over a closed connection is reported (conn_transport)', async ({ crowd }) => {
  const [alice, bob] = await pair(crowd);
  await needHooks(alice);
  alice.expectInvariant('conn_transport');
  // Bob notices the link is gone and offers a restart, which would rebuild the connection on Alice's side: held back.
  alice.wire.down = (frame) => ((JSON.parse(frame) as { t?: string }).t === 'signal' ? null : frame);
  bob.expectWarning(/ICE failed/); // Firefox says so while his restarts go unanswered
  expect(await alice.hook('closeQuietly', 'Bob')).toBe('closed');
  await expect.poll(fired(alice), { timeout: REPORTED_WITHIN }).toEqual(['conn_transport']);
  await expect(alice.badge('Bob')).toHaveText(/^(direct|via relay)$/);
});

test('a handshake that fails while ICE stays connected takes the badge off "direct", and it comes back once the link works', async ({ crowd }) => {
  const [alice] = await pair(crowd);
  await needHooks(alice);
  // What conn_transport would otherwise report: a badge left green over a failed connection.
  expect(await alice.hook('failHandshake', 'Bob')).toBe('unreachable');
  await alice.connectedTo('Bob');
  await alice.hearing('Bob');
  expect(await alice.invariants()).toEqual([]);
});
