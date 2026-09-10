// Identity and the shared-secret handshake (ADR 0003). WebCrypto only, so this
// runs unchanged in browsers, workerd, and Node. No imports.

const subtle = () => crypto.subtle;

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url. Returns null for malformed input instead of throwing; callers treat null as a failed check. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let s: string;
  try {
    s = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
const PUBLIC_KEY_BYTES = 65; // uncompressed point, 0x04 || X || Y

// 32 symbols, no l/o/0/1 so fingerprints survive being read aloud.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Six characters (30 bits) of the SHA-256 of the raw public key. */
export async function fingerprint(publicKeyRaw: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await subtle().digest('SHA-256', publicKeyRaw as BufferSource));
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of hash) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 6) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 6) break;
  }
  return out;
}

export function isValidPublicKey(raw: Uint8Array): boolean {
  return raw.length === PUBLIC_KEY_BYTES && raw[0] === 0x04;
}

/** Client side: create a non-extractable identity keypair. The public half is always exportable. */
export function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  // Workers types widen this to CryptoKeyPair | CryptoKey; ECDSA always yields a pair.
  return subtle().generateKey(P256, false, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await subtle().exportKey('raw', publicKey)) as ArrayBuffer);
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return subtle().importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/**
 * Client side: prove possession of the shared secret and of the private key.
 * hmac = HMAC-SHA256(secret, nonce || publicKey); signature = ECDSA(privateKey, nonce).
 */
export async function answerChallenge(input: {
  secret: string;
  nonce: Uint8Array;
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
}): Promise<{ hmac: Uint8Array; signature: Uint8Array }> {
  const key = await hmacKey(input.secret, 'sign');
  const hmac = new Uint8Array(await subtle().sign('HMAC', key, concat(input.nonce, input.publicKeyRaw) as BufferSource));
  const signature = new Uint8Array(await subtle().sign(SIGN, input.privateKey, input.nonce as BufferSource));
  return { hmac, signature };
}

/** Server side. Both checks are constant time inside WebCrypto; the secret never leaves the server. */
export async function verifyAnswer(input: {
  secret: string;
  nonce: Uint8Array;
  publicKeyRaw: Uint8Array;
  hmac: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  if (!isValidPublicKey(input.publicKeyRaw)) return false;
  const key = await hmacKey(input.secret, 'verify');
  const macOk = await subtle().verify('HMAC', key, input.hmac as BufferSource, concat(input.nonce, input.publicKeyRaw) as BufferSource);
  if (!macOk) return false;
  const publicKey = await importPublicKey(input.publicKeyRaw);
  return publicKey ? verifyBytes(publicKey, input.signature, input.nonce) : false;
}

/** Imports a raw uncompressed P-256 public key for verification; null when the bytes are not a valid point. */
export async function importPublicKey(publicKeyRaw: Uint8Array): Promise<CryptoKey | null> {
  if (!isValidPublicKey(publicKeyRaw)) return null;
  try {
    return await subtle().importKey('raw', publicKeyRaw as BufferSource, P256, true, ['verify']);
  } catch {
    return null;
  }
}

/** ECDSA P-256 with SHA-256 over arbitrary bytes, the identity key's one signing scheme. */
export async function signBytes(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign(SIGN, privateKey, bytes as BufferSource));
}

export function verifyBytes(publicKey: CryptoKey, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  return subtle().verify(SIGN, publicKey, signature as BufferSource, bytes as BufferSource);
}

/** Client side: turn a challenge into the complete `auth` message. Shared by the app and the tests. */
export async function buildAuthMessage(input: {
  secret: string;
  nonce: string;
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
  name: string;
}): Promise<{ t: 'auth'; publicKey: string; name: string; hmac: string; signature: string }> {
  const nonce = fromBase64Url(input.nonce);
  if (!nonce) throw new Error('malformed challenge nonce');
  const { hmac, signature } = await answerChallenge({ secret: input.secret, nonce, publicKeyRaw: input.publicKeyRaw, privateKey: input.privateKey });
  return { t: 'auth', publicKey: toBase64Url(input.publicKeyRaw), name: input.name, hmac: toBase64Url(hmac), signature: toBase64Url(signature) };
}
