import { exportPublicKey, fingerprint, generateIdentityKeyPair, toBase64Url } from '../core/identity';
import { idbGet, idbSet } from './storage';

export type LocalIdentity = {
  keys: CryptoKeyPair;
  publicKeyRaw: Uint8Array;
  publicKey: string;
  fingerprint: string;
};

/** Load the browser's identity keypair, creating it on first visit. Losing site data means a new identity; there is no recovery by design. */
export async function loadIdentity(): Promise<LocalIdentity> {
  let keys = await idbGet<CryptoKeyPair>('identity');
  if (!keys) {
    keys = await generateIdentityKeyPair();
    await idbSet('identity', keys);
  }
  const publicKeyRaw = await exportPublicKey(keys.publicKey);
  return { keys, publicKeyRaw, publicKey: toBase64Url(publicKeyRaw), fingerprint: await fingerprint(publicKeyRaw) };
}
