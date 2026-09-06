// Identity and the shared-secret handshake (ADR 0003). WebCrypto only, so this
// runs unchanged in browsers, workerd, and Node. No imports.

const subtle = () => crypto.subtle;

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const s = atob(b64);
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
  let publicKey: CryptoKey;
  try {
    publicKey = await subtle().importKey('raw', input.publicKeyRaw as BufferSource, P256, true, ['verify']);
  } catch {
    return false;
  }
  return subtle().verify(SIGN, publicKey, input.signature as BufferSource, input.nonce as BufferSource);
}
