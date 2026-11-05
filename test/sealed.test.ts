import { describe, expect, it } from 'vitest';
import { exportPublicKey, fromBase64Url, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { MAX_NAME_LENGTH, MAX_SEALED_FILE_LENGTH, MAX_SEALED_LENGTH, MAX_SEALED_PIECE_LENGTH, MAX_SEALED_PROFILE_LENGTH, MAX_TEXT_LENGTH } from '../src/core/protocol';
import { KEPT_PIECE_BYTES } from '../src/core/kept';
import { MAX_FILE_NAME, MAX_PREVIEW_LENGTH, type FileMeta } from '../src/core/attachment';
import { roomIdOf, textKeyOf } from '../src/core/rooms';
import { generatePrivateTextKeyPair, openFile, openPiece, openProfile, openText, pairSecret, sealFile, sealPiece, sealProfile, sealText, signPrivateTextKey, verifyPrivateTextKey } from '../src/core/sealed';

async function writer() {
  const keys = await generateIdentityKeyPair();
  return { privateKey: keys.privateKey, from: toBase64Url(await exportPublicKey(keys.publicKey)) };
}

describe('sealed texts (ADR 0005)', async () => {
  const key = await textKeyOf('a secret');
  const roomId = await roomIdOf('a secret');
  const alice = await writer();
  const seal = (text: string, over: Partial<Parameters<typeof sealText>[0]> = {}) => sealText({ key, roomId, id: 'c0ffee', text, ...alice, ...over });
  const open = (sealed: string, over: Partial<Parameters<typeof openText>[0]> = {}) => openText({ key, roomId, id: 'c0ffee', from: alice.from, sealed, ...over });

  it('round-trips a text, newlines and emoji included, and seals it anew each time', async () => {
    const text = 'hello 👋\nsecond line';
    const sealed = await seal(text);
    expect(await open(sealed)).toEqual({ ok: true, text });
    expect(await seal(text)).not.toBe(sealed);
  });

  it('the text key is derived from the secret, differs per secret, and cannot be read back out', async () => {
    expect(key.extractable).toBe(false);
    const sealed = await seal('hi');
    expect(await openText({ key: await textKeyOf('a secret'), roomId, id: 'c0ffee', from: alice.from, sealed })).toEqual({ ok: true, text: 'hi' });
    expect(await open(sealed, { key: await textKeyOf('another secret') })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('does not show the text, nor its exact length, on the wire', async () => {
    const sealed = await seal('a secret plan');
    expect(sealed).not.toContain('secret');
    expect(new TextDecoder().decode(fromBase64Url(sealed)!)).not.toContain('secret');
    expect((await seal('a')).length).toBe((await seal('a'.repeat(150))).length);
    expect((await seal('a')).length).toBeLessThan((await seal('a'.repeat(300))).length);
  });

  it('the longest text a client can write stays within what the Room takes', async () => {
    for (const text of ['x'.repeat(MAX_TEXT_LENGTH), '€'.repeat(MAX_TEXT_LENGTH), '\uD800'.repeat(MAX_TEXT_LENGTH), '😀'.repeat(MAX_TEXT_LENGTH / 2)]) {
      expect((await seal(text)).length).toBeLessThanOrEqual(MAX_SEALED_LENGTH);
    }
  });

  it('refuses a text moved to another room or another id', async () => {
    const sealed = await seal('hi');
    expect(await open(sealed, { roomId: await roomIdOf('another secret') })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await open(sealed, { id: 'beef' })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a text the server says came from someone else', async () => {
    const bob = await writer();
    expect(await open(await seal('hi'), { from: bob.from })).toEqual({ ok: false, reason: 'bad signature' });
    expect(await open(await seal('hi'), { from: 'not a key' })).toEqual({ ok: false, reason: 'bad key' });
  });

  it('refuses a text a member signed in the name of another', async () => {
    // Mallory holds the room's key, so she can seal, but only with her own identity key.
    const mallory = await writer();
    const forged = await seal('send money', { privateKey: mallory.privateKey });
    expect(await open(forged)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('refuses a tampered, truncated or malformed blob without throwing', async () => {
    const bytes = fromBase64Url(await seal('hi'))!;
    const flipped = bytes.slice();
    flipped[20]! ^= 1;
    expect(await open(toBase64Url(flipped))).toEqual({ ok: false, reason: 'unreadable' });
    expect(await open(toBase64Url(bytes.subarray(0, bytes.length - 1)))).toEqual({ ok: false, reason: 'unreadable' });
    expect(await open(toBase64Url(bytes.subarray(0, 40)))).toEqual({ ok: false, reason: 'unreadable' });
    expect(await open('not base64!')).toEqual({ ok: false, reason: 'unreadable' });
    expect(await open('')).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a properly signed text the composer would never have sent', async () => {
    expect(await open(await seal('   '))).toEqual({ ok: false, reason: 'invalid text' });
    expect(await open(await seal('x'.repeat(MAX_TEXT_LENGTH + 1)))).toEqual({ ok: false, reason: 'invalid text' });
  });
});

describe('sealed file announcements (ADR 0006)', async () => {
  const key = await textKeyOf('a secret');
  const roomId = await roomIdOf('a secret');
  const alice = await writer();
  const file: FileMeta = { name: 'cat.jpg', type: 'image/jpeg', size: 2_000_000, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg', preview: 'data:image/webp;base64,UklGRg==', width: 4032, height: 3024 };
  const base = { key, roomId, id: 'c0ffee', ...alice };

  it('round-trips a file description, and nothing of it shows on the wire', async () => {
    const sealed = await sealFile({ ...base, file });
    expect(await openFile({ ...base, sealed })).toEqual({ ok: true, file });
    expect(sealed).not.toContain('cat');
    expect(new TextDecoder().decode(fromBase64Url(sealed)!)).not.toContain('cat');
  });

  it('a text cannot be passed off as a file, nor a file as a text', async () => {
    const asText = await sealText({ ...base, text: JSON.stringify(file) });
    expect(await openFile({ ...base, sealed: asText })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await openText({ ...base, sealed: await sealFile({ ...base, file }) })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses one signed by another member, or one that does not describe a file', async () => {
    const mallory = await writer();
    expect(await openFile({ ...base, sealed: await sealFile({ ...base, privateKey: mallory.privateKey, file }) })).toEqual({ ok: false, reason: 'bad signature' });
    expect(await openFile({ ...base, sealed: await sealFile({ ...base, file: { ...file, hash: 'nope' } }) })).toEqual({ ok: false, reason: 'invalid file' });
  });

  it('the longest description a client can write stays within what the Room takes', async () => {
    const longest: FileMeta = { ...file, name: '😀'.repeat(MAX_FILE_NAME / 2), type: 'x'.repeat(100), preview: `data:image/jpeg;base64,${'A'.repeat(MAX_PREVIEW_LENGTH - 23)}`, size: 104857600 };
    const sealed = await sealFile({ ...base, file: longest });
    expect(sealed.length).toBeLessThanOrEqual(MAX_SEALED_FILE_LENGTH);
    expect(await openFile({ ...base, sealed })).toEqual({ ok: true, file: longest });
  });
});

describe('rooms of two (ADR 0011), from private text keys (ADR 0007)', async () => {
  /** A friend with an identity and a private text key, published as the app publishes it. */
  async function friend() {
    const w = await writer();
    const keys = await generatePrivateTextKeyPair();
    const key = toBase64Url(await exportPublicKey(keys.publicKey));
    return { ...w, keys, published: { key, sig: await signPrivateTextKey({ privateKey: w.privateKey, identity: w.from, key }) } };
  }
  type Friend = Awaited<ReturnType<typeof friend>>;
  const secretOf = (me: Friend, them: Friend) => pairSecret({ mine: me.keys.privateKey, theirs: them.published.key, me: me.from, them: them.from });
  const alice = await friend();
  const bob = await friend();
  const carol = await friend();

  it('both friends derive the same secret, each on their own, and the private half never leaves', async () => {
    expect(alice.keys.privateKey.extractable).toBe(false);
    const secret = await secretOf(alice, bob);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await secretOf(bob, alice)).toBe(secret);
    // A room of its own, like any: its id, auth key and text key come from it.
    expect(await roomIdOf(secret!)).toBe(await roomIdOf((await secretOf(bob, alice))!));
  });

  it('every pair has its own, and nobody else can derive it: not a third friend, not with the published keys alone', async () => {
    const ab = await secretOf(alice, bob);
    expect(await secretOf(alice, carol)).not.toBe(ab);
    expect(await secretOf(carol, bob)).not.toBe(ab);
    // Carol with Alice's published key and Bob's identity named: her own private half gives another secret.
    expect(await pairSecret({ mine: carol.keys.privateKey, theirs: alice.published.key, me: bob.from, them: alice.from })).not.toBe(ab);
    // Bound to both identities: the same keys under other names give another.
    expect(await pairSecret({ mine: alice.keys.privateKey, theirs: bob.published.key, me: alice.from, them: carol.from })).not.toBe(ab);
    expect(await pairSecret({ mine: alice.keys.privateKey, theirs: 'AAAA', me: alice.from, them: bob.from })).toBeNull();
  });

  it('a private text key counts only with the signature of its own identity, so a server cannot slip in its own', async () => {
    expect(await verifyPrivateTextKey({ identity: bob.from, ...bob.published })).toBe(true);
    // The server's key in Bob's place: signed by nobody, or by an identity that is not Bob's.
    expect(await verifyPrivateTextKey({ identity: bob.from, key: carol.published.key, sig: bob.published.sig })).toBe(false);
    expect(await verifyPrivateTextKey({ identity: bob.from, ...carol.published })).toBe(false);
    expect(await verifyPrivateTextKey({ identity: bob.from, key: 'not a key', sig: bob.published.sig })).toBe(false);
    expect(await verifyPrivateTextKey({ identity: 'not a key', ...bob.published })).toBe(false);
  });
});

describe('sealed profiles (ADR 0010)', async () => {
  const key = await textKeyOf('a secret');
  const roomId = await roomIdOf('a secret');
  const alice = await writer();
  const bob = await writer();
  const profile = { name: 'Alice', picture: '🦕' };
  const seal = (p: object = profile, over: Partial<Parameters<typeof sealProfile>[0]> = {}) => sealProfile({ key, roomId, ...alice, profile: p as typeof profile, ...over });
  const open = (sealed: string, over: Partial<Parameters<typeof openProfile>[0]> = {}) => openProfile({ key, roomId, from: alice.from, sealed, ...over });

  it('round-trips a name and picture, and shows neither on the wire', async () => {
    const sealed = await seal();
    expect(await open(sealed)).toEqual(profile);
    expect(await open(await seal({ name: 'Alice' }))).toEqual({ name: 'Alice' });
    expect(new TextDecoder().decode(fromBase64Url(sealed)!)).not.toContain('Alice');
    expect(sealed).not.toContain('Alice');
  });

  it('opens only in its room, under its writer, and not as a text', async () => {
    const sealed = await seal();
    expect(await open(sealed, { roomId: await roomIdOf('another') })).toBeNull();
    expect(await open(sealed, { key: await textKeyOf('another') })).toBeNull();
    expect(await open(sealed, { from: bob.from }), 'listed under another identity').toBeNull();
    expect(await openText({ key, roomId, id: 'profile', from: alice.from, sealed })).toMatchObject({ ok: false });
    // Bob seals a profile with his own key and the server lists it under Alice: refused.
    expect(await open(await seal(profile, { privateKey: bob.privateKey }))).toBeNull();
  });

  it('refuses a name or picture the composer would not make: the server can no longer check them', async () => {
    for (const bad of [{ name: '  Alice ' }, { name: '' }, { name: 'x'.repeat(MAX_NAME_LENGTH + 1) }, { name: 'Alice', picture: 'ab' }, {}, { name: 7 }]) {
      expect(await open(await seal(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the longest profile a client can write stays within what the Room takes', async () => {
    // JSON escapes a control character to six bytes, the most one character can take.
    for (const name of ['\u0001'.repeat(MAX_NAME_LENGTH), '"'.repeat(MAX_NAME_LENGTH), '😀'.repeat(MAX_NAME_LENGTH / 2)]) {
      const sealed = await seal({ name, picture: '👨‍👩‍👧‍👦' });
      expect(sealed.length, JSON.stringify(name)).toBeLessThanOrEqual(MAX_SEALED_PROFILE_LENGTH);
      expect(await open(sealed), 'and it opens').toEqual({ name, picture: '👨‍👩‍👧‍👦' });
    }
  });

});

describe('sealed pieces of a kept file (ADR 0009)', async () => {
  const key = await textKeyOf('a secret');
  const roomId = await roomIdOf('a secret');
  const bytes = new Uint8Array(KEPT_PIECE_BYTES).map((_, i) => i % 251);
  const where = { key, roomId, hash: 'h'.repeat(43), n: 2, of: 5 };

  it('round-trips a piece, shows nothing of it, and fits what the Room takes', async () => {
    const sealed = await sealPiece({ ...where, bytes });
    expect(await openPiece({ ...where, sealed })).toEqual(bytes);
    expect(toBase64Url(sealed).length).toBeLessThanOrEqual(MAX_SEALED_PIECE_LENGTH);
    expect(sealed.subarray(12, 12 + 64)).not.toEqual(bytes.subarray(0, 64));
  });

  it('opens only for its room, file, place and count, and never throws', async () => {
    const sealed = await sealPiece({ ...where, bytes });
    for (const over of [{ roomId: await roomIdOf('another') }, { key: await textKeyOf('another') }, { hash: 'g'.repeat(43) }, { n: 3 }, { of: 6 }]) {
      expect(await openPiece({ ...where, ...over, sealed }), JSON.stringify(Object.keys(over))).toBeNull();
    }
    expect(await openPiece({ ...where, sealed: sealed.subarray(0, 10) })).toBeNull();
    const flipped = sealed.slice();
    flipped[40] = flipped[40]! ^ 1;
    expect(await openPiece({ ...where, sealed: flipped })).toBeNull();
  });
});
