import { describe, expect, it } from 'vitest';
import { exportPublicKey, fromBase64Url, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';
import { MAX_SEALED_LENGTH, MAX_TEXT_LENGTH } from '../src/core/protocol';
import { roomIdOf, textKeyOf } from '../src/core/rooms';
import { openText, sealText } from '../src/core/sealed';

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
