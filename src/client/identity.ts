import { exportPublicKey, fingerprint, generateIdentityKeyPair, toBase64Url } from '../core/identity';
import { generatePrivateTextKeyPair, signPrivateTextKey } from '../core/sealed';
import type { PrivateTextKey } from '../core/protocol';
import { idbGet, idbKeep, idbSet } from './storage';

export type LocalIdentity = {
  keys: CryptoKeyPair;
  publicKeyRaw: Uint8Array;
  publicKey: string;
  fingerprint: string;
  /**
   * My private text key (ADR 0007): its pair, and its public half as friends get it, signed by the identity. Null when
   * this browser cannot keep one (storage full, say): everything else works, private texts do not.
   */
  privateTexts: { keys: CryptoKeyPair; published: PrivateTextKey } | null;
};

/** Load the browser's identity keypair, creating it on first visit. Losing site data means a new identity; there is no recovery by design. */
export async function loadIdentity(): Promise<LocalIdentity> {
  let keys = await idbGet<CryptoKeyPair>('identity');
  if (!keys) {
    keys = await generateIdentityKeyPair();
    await idbSet('identity', keys);
  }
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  const publicKey = toBase64Url(publicKeyRaw);
  return { keys, publicKeyRaw, publicKey, fingerprint: await fingerprint(publicKeyRaw), privateTexts: await loadPrivateTextKey(keys.privateKey, publicKey) };
}

/**
 * The identity I go by in my room of two with `friend` (ADR 0011): a key of its own, kept for that conversation alone, so
 * nothing the server sees ties it to my identity or to my rooms. No private text key: none is published there.
 */
export async function pairIdentity(friend: string): Promise<LocalIdentity> {
  const keys = (await idbGet<CryptoKeyPair>(`pairIdentity:${friend}`)) ?? (await idbKeep(`pairIdentity:${friend}`, await generateIdentityKeyPair()));
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  return { keys, publicKeyRaw, publicKey: toBase64Url(publicKeyRaw), fingerprint: await fingerprint(publicKeyRaw), privateTexts: null };
}

/** The private text key, made on the first load since ADR 0007; null when it cannot be kept, which must not keep the app from opening. */
async function loadPrivateTextKey(identityKey: CryptoKey, identity: string): Promise<LocalIdentity['privateTexts']> {
  try {
    // Kept only if none is stored by then: two tabs opened at once each make one, and both must use the same.
    const keys = (await idbGet<CryptoKeyPair>('privateTextKey')) ?? (await idbKeep('privateTextKey', await generatePrivateTextKeyPair()));
    const key = toBase64Url(await exportPublicKey(keys.publicKey));
    return { keys, published: { key, sig: await signPrivateTextKey({ privateKey: identityKey, identity, key }) } };
  } catch (e) {
    console.warn('no private text key in this browser', e);
    return null;
  }
}
