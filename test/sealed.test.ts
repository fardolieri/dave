import { describe, expect, it } from 'vitest';
import { exportPublicKey, fromBase64Url, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { MAX_SEALED_FILE_LENGTH, MAX_SEALED_LENGTH, MAX_TEXT_LENGTH } from '../src/core/protocol';
import { MAX_FILE_NAME, MAX_PREVIEW_LENGTH, type FileMeta } from '../src/core/attachment';
import { roomIdOf, textKeyOf } from '../src/core/rooms';
import { generatePrivateTextKeyPair, openFile, openPrivate, openPrivateFile, openText, sealFile, sealPrivate, sealPrivateFile, sealText, sharedPrivateTextKey, signPrivateTextKey, verifyPrivateTextKey } from '../src/core/sealed';

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

describe('private texts (ADR 0007)', async () => {
  const roomId = await roomIdOf('a secret');
  /** A friend with an identity and a private text key, published as the app publishes it. */
  async function friend() {
    const w = await writer();
    const keys = await generatePrivateTextKeyPair();
    const key = toBase64Url(await exportPublicKey(keys.publicKey));
    return { ...w, keys, published: { key, sig: await signPrivateTextKey({ privateKey: w.privateKey, identity: w.from, key }) } };
  }
  type Friend = Awaited<ReturnType<typeof friend>>;
  const shared = async (me: Friend, them: Friend) => (await sharedPrivateTextKey({ mine: me.keys.privateKey, theirs: them.published.key, me: me.from, them: them.from }))!;
  const alice = await friend();
  const bob = await friend();
  const carol = await friend();
  const toBob = async (text: string) => sealPrivate({ key: await shared(alice, bob), privateKey: alice.privateKey, roomId, id: 'c0ffee', from: alice.from, to: bob.from, text });
  const asBob = async (sealed: string, over: Partial<Parameters<typeof openPrivate>[0]> = {}) =>
    openPrivate({ key: await shared(bob, alice), roomId, id: 'c0ffee', from: alice.from, to: bob.from, sealed, ...over });

  it('round-trips between the two friends, with a key each derives on their own, and the private half never leaves', async () => {
    expect(alice.keys.privateKey.extractable).toBe(false);
    expect(await asBob(await toBob('just between us 🤫'))).toEqual({ ok: true, text: 'just between us 🤫' });
    // The other way round, the same pair of keys.
    const back = await sealPrivate({ key: await shared(bob, alice), privateKey: bob.privateKey, roomId, id: 'beef', from: bob.from, to: alice.from, text: 'ok' });
    expect(await openPrivate({ key: await shared(alice, bob), roomId, id: 'beef', from: bob.from, to: alice.from, sealed: back })).toEqual({ ok: true, text: 'ok' });
  });

  it('another friend of the room cannot open it, with the room key or with a key of her own', async () => {
    const sealed = await toBob('just between us');
    expect(new TextDecoder().decode(fromBase64Url(sealed)!)).not.toContain('between');
    expect(await asBob(sealed, { key: await shared(carol, alice) })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await asBob(sealed, { key: await textKeyOf('a secret') })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('cannot be passed off as a text to the room, as one to another friend, or as one from another', async () => {
    const sealed = await toBob('hi');
    expect(await asBob(sealed, { to: carol.from })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await asBob(sealed, { id: 'beef' })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await asBob(sealed, { roomId: await roomIdOf('another secret') })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await asBob(sealed, { from: carol.from })).toEqual({ ok: false, reason: 'bad signature' });
    const key = await textKeyOf('a secret');
    const asText = await sealText({ key, privateKey: alice.privateKey, roomId, id: 'c0ffee', from: alice.from, text: 'hi' });
    expect(await asBob(asText, { key })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await openText({ key, roomId, id: 'c0ffee', from: alice.from, sealed: await sealPrivate({ key, privateKey: alice.privateKey, roomId, id: 'c0ffee', from: alice.from, to: bob.from, text: 'hi' }) })).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a private text key counts only with the signature of its own identity, so a server cannot slip in its own', async () => {
    expect(await verifyPrivateTextKey({ identity: bob.from, ...bob.published })).toBe(true);
    // The server's key in Bob's place: signed by nobody, or by an identity that is not Bob's.
    expect(await verifyPrivateTextKey({ identity: bob.from, key: carol.published.key, sig: bob.published.sig })).toBe(false);
    expect(await verifyPrivateTextKey({ identity: bob.from, ...carol.published })).toBe(false);
    expect(await verifyPrivateTextKey({ identity: bob.from, key: 'not a key', sig: bob.published.sig })).toBe(false);
    expect(await verifyPrivateTextKey({ identity: 'not a key', ...bob.published })).toBe(false);
    expect(await sharedPrivateTextKey({ mine: alice.keys.privateKey, theirs: 'AAAA', me: alice.from, them: bob.from })).toBeNull();
  });

  it('a file for one friend round-trips for them alone, and is never taken for a private text or a room\'s file', async () => {
    const file: FileMeta = { name: 'secret.png', type: 'image/png', size: 2048, hash: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg' };
    const key = await shared(alice, bob);
    const base = { key, privateKey: alice.privateKey, roomId, id: 'c0ffee', from: alice.from, to: bob.from };
    const sealed = await sealPrivateFile({ ...base, file });
    expect(await openPrivateFile({ ...base, key: await shared(bob, alice), sealed })).toEqual({ ok: true, file });
    expect(await openPrivateFile({ ...base, key: await shared(carol, alice), sealed })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await openPrivate({ ...base, sealed })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await openPrivateFile({ ...base, sealed: await sealPrivate({ ...base, text: JSON.stringify(file) }) })).toEqual({ ok: false, reason: 'unreadable' });
    expect(await openFile({ key, roomId, id: 'c0ffee', from: alice.from, sealed })).toEqual({ ok: false, reason: 'unreadable' });
    expect((await sealPrivateFile({ ...base, file: { ...file, name: '😀'.repeat(MAX_FILE_NAME / 2), type: 'x'.repeat(100), preview: `data:image/jpeg;base64,${'A'.repeat(MAX_PREVIEW_LENGTH - 23)}` } })).length).toBeLessThanOrEqual(MAX_SEALED_FILE_LENGTH);
  });

  it('the longest private text stays within what the Room takes, and an empty one is refused', async () => {
    expect((await toBob('€'.repeat(MAX_TEXT_LENGTH))).length).toBeLessThanOrEqual(MAX_SEALED_LENGTH);
    expect(await asBob(await toBob('  '))).toEqual({ ok: false, reason: 'invalid text' });
  });
});
