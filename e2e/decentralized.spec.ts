import { expect, test } from './fixtures';

// Acceptance tests for .scratch/decentralized-rooms (spec.md, tickets 01 to 05). They describe the target and are marked
// fixme until the ticket that makes them true lands; flip each to `test` in that ticket. The adversary here is the proxy in
// fixtures.ts playing the server.

test.describe('ticket 01: room links and membership proof', () => {
  test.fixme('visitors hold verified room links to each other without joining a call', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    // Visitors show a link state in the Online list once the room link is up and the proof passed.
    await expect(alice.page.locator('aside.side > ul.plist li', { hasText: 'Bob' }).locator('.conn')).toHaveText(/^(direct|via relay)$/);
    await expect(bob.page.locator('aside.side > ul.plist li', { hasText: 'Alice' }).locator('.conn')).toHaveText(/^(direct|via relay)$/);
  });

  test.fixme('a member the server invents is refused by every peer', async () => {
    // The server knows the auth key, so it can pass anyone through its own gate. It cannot know the member key.
    // Bob's proxy injects a presence entry for a key only the "server" holds, and relays its signaling; Bob must mark it
    // unverified and never show it as a friend.
  });
});

test.describe('ticket 02: text over room links', () => {
  test.fixme('a friend who arrives later receives the history from peers', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    await alice.say('before carol');
    await expect.poll(() => bob.chatTexts()).toEqual(['before carol']);
    const carol = await crowd.open('Carol');
    await expect.poll(() => carol.chatTexts()).toEqual(['before carol']);
  });

  test.fixme('text reaches a friend whose direct link to the author failed, through another friend', async ({ crowd }) => {
    // Needs a way to block the Alice-Carol room link (drop their signaling in the proxy); Bob forwards.
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    const carol = await crowd.open('Carol');
    void bob;
    await alice.say('via bob');
    await expect.poll(() => carol.chatTexts()).toEqual(['via bob']);
  });

  test.fixme('the server never sees text', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    await alice.say('a secret plan');
    await expect.poll(() => bob.chatTexts()).toEqual(['a secret plan']);
    for (const f of [alice, bob]) expect(f.wire.log.filter((l) => l.frame.includes('a secret plan'))).toEqual([]);
  });

  test.fixme('a text tampered with in transit by a peer is dropped', async () => {
    // A test peer (a page with a patched client, or a raw RTCPeerConnection in Node) forwards Alice's message with its text changed.
  });

  test.fixme('clearing history is not undone by the next sync', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    await alice.say('old');
    await expect.poll(() => bob.chatTexts()).toEqual(['old']);
    bob.page.once('dialog', (d) => void d.accept());
    await bob.page.getByRole('button', { name: 'Clear chat history' }).click();
    await bob.page.reload();
    await bob.connected();
    await bob.page.waitForTimeout(3000); // sync with Alice has run
    expect(await bob.chatTexts()).toEqual([]);
  });
});

test.describe('ticket 03: encrypted mailbox', () => {
  test.fixme('a text reaches a friend who was never online at the same time as the author', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    await alice.say('left for bob');
    await alice.close();
    const bob = await crowd.open('Bob');
    await expect.poll(() => bob.chatTexts()).toEqual(['left for bob']);
    // What the server stored is opaque to it.
    expect(bob.wire.log.filter((l) => l.frame.includes('left for bob'))).toEqual([]);
  });

  test.fixme('a mailbox entry the server forged or altered is dropped', async () => {
    // Bob's proxy flips a byte in one entry of the `mail` reply and adds an entry sealed with a wrong key.
  });
});

test.describe('ticket 04: profiles and call control over room links', () => {
  test.fixme('the server never learns names', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    await expect.poll(() => bob.online()).toContain('Alice');
    for (const f of [alice, bob]) expect(f.wire.log.filter((l) => /"name"/.test(l.frame))).toEqual([]);
  });
});

test.describe('ticket 05: encrypted signaling', () => {
  test.fixme('the server sees no SDP and no ICE candidates', async ({ crowd }) => {
    const alice = await crowd.open('Alice');
    const bob = await crowd.open('Bob');
    await alice.join();
    await bob.join();
    await alice.connectedTo('Bob');
    for (const f of [alice, bob]) expect(f.wire.log.filter((l) => /a=fingerprint|candidate:/.test(l.frame))).toEqual([]);
  });
});
