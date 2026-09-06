import { describe, expect, it } from 'vitest';
import { answerChallenge, exportPublicKey, fingerprint, fromBase64Url, generateIdentityKeyPair, randomNonce, toBase64Url, verifyAnswer } from '../src/core/identity';

describe('identity primitives', () => {
  it('base64url round-trips and strips padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
  });

  it('fingerprints are six readable characters and deterministic', async () => {
    const keys = await generateIdentityKeyPair();
    const raw = await exportPublicKey(keys.publicKey);
    expect(raw.length).toBe(65);
    const a = await fingerprint(raw);
    expect(a).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{6}$/);
    expect(await fingerprint(raw)).toBe(a);
    const other = await exportPublicKey((await generateIdentityKeyPair()).publicKey);
    expect(await fingerprint(other)).not.toBe(a);
  });

  it('the private key is not extractable, the public key is', async () => {
    const keys = await generateIdentityKeyPair();
    expect(keys.privateKey.extractable).toBe(false);
    await expect(exportPublicKey(keys.publicKey)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('challenge and answer', () => {
  const secret = 'correct horse battery staple';

  async function setup() {
    const keys = await generateIdentityKeyPair();
    const publicKeyRaw = await exportPublicKey(keys.publicKey);
    const nonce = randomNonce();
    const answer = await answerChallenge({ secret, nonce, publicKeyRaw, privateKey: keys.privateKey });
    return { keys, publicKeyRaw, nonce, answer };
  }

  it('accepts a correct answer', async () => {
    const { publicKeyRaw, nonce, answer } = await setup();
    expect(await verifyAnswer({ secret, nonce, publicKeyRaw, ...answer })).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const { publicKeyRaw, nonce, answer } = await setup();
    expect(await verifyAnswer({ secret: 'wrong', nonce, publicKeyRaw, ...answer })).toBe(false);
  });

  it('rejects a replay against a fresh nonce', async () => {
    const { publicKeyRaw, answer } = await setup();
    expect(await verifyAnswer({ secret, nonce: randomNonce(), publicKeyRaw, ...answer })).toBe(false);
  });

  it('rejects a signature from a different key even with a correct hmac', async () => {
    const { publicKeyRaw, nonce, answer } = await setup();
    const impostor = await generateIdentityKeyPair();
    const forged = await answerChallenge({ secret, nonce, publicKeyRaw, privateKey: impostor.privateKey });
    expect(await verifyAnswer({ secret, nonce, publicKeyRaw, hmac: answer.hmac, signature: forged.signature })).toBe(false);
  });

  it('rejects a malformed public key', async () => {
    const { nonce, answer } = await setup();
    expect(await verifyAnswer({ secret, nonce, publicKeyRaw: new Uint8Array(10), ...answer })).toBe(false);
  });
});
