// Sealed texts (ADR 0005). A text leaves the writer's browser encrypted with the room's text key, which is derived from
// the shared secret and never reaches the server, and signed with the writer's identity key inside the encryption. The
// Room relays (and later stores) what it cannot read; a friend opens it and checks that the identity the server says it
// came from wrote it, for this room and under this id.
//
// Inside: signature (64 bytes) || UTF-8 text || 0x80 || zeros up to a multiple of 256 bytes, so the length on the wire
// says little. Outside: iv (12 bytes) || AES-GCM ciphertext and tag, base64url. The additional data binds the room and
// the id, so a sealed text cannot be passed off in another room or under another id.
//
// WebCrypto only; runs unchanged in browsers, workerd and Node.
import { fromBase64Url, importPublicKey, signBytes, toBase64Url, verifyBytes } from './identity';
import { MAX_TEXT_LENGTH } from './protocol';

const DOMAIN = 'dave text v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SIGNATURE_BYTES = 64; // ECDSA P-256 as WebCrypto writes it: r || s
const BUCKET = 256;

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The bytes the writer signs and every friend verifies. Keys, room ids and text ids hold no newline; the text comes last. */
export function textBindingBytes(input: { roomId: string; id: string; from: string; text: string }): Uint8Array {
  return utf8([DOMAIN, input.roomId, input.id, input.from, input.text].join('\n'));
}

const additionalData = (roomId: string, id: string) => utf8([DOMAIN, roomId, id].join('\n'));

function pad(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((bytes.length + 1) / BUCKET) * BUCKET);
  out.set(bytes);
  out[bytes.length] = 0x80;
  return out;
}

function unpad(bytes: Uint8Array): Uint8Array | null {
  let end = bytes.length - 1;
  while (end >= 0 && bytes[end] === 0) end--;
  return end >= 0 && bytes[end] === 0x80 ? bytes.subarray(0, end) : null;
}

/** Writer side: the text sealed for this room, signed by `from` (the writer's own public key, base64url). */
export async function sealText(input: { key: CryptoKey; privateKey: CryptoKey; roomId: string; id: string; from: string; text: string }): Promise<string> {
  const signature = await signBytes(input.privateKey, textBindingBytes(input));
  const text = utf8(input.text);
  const inner = new Uint8Array(signature.length + text.length);
  inner.set(signature);
  inner.set(text, signature.length);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(input.roomId, input.id) as BufferSource }, input.key, pad(inner) as BufferSource,
  ));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

export type OpenedText = { ok: true; text: string } | { ok: false; reason: 'unreadable' | 'bad signature' | 'bad key' | 'invalid text' };

/**
 * Reader side: the text, if it was sealed with this room's key under this id and signed by `from`, the identity the
 * server attributed it to. Anything else is refused with the reason, never thrown.
 */
export async function openText(input: { key: CryptoKey; roomId: string; id: string; from: string; sealed: string }): Promise<OpenedText> {
  const bytes = fromBase64Url(input.sealed);
  if (!bytes || bytes.length < IV_BYTES + TAG_BYTES + BUCKET) return { ok: false, reason: 'unreadable' };
  let inner: Uint8Array | null;
  try {
    inner = unpad(new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) as BufferSource, additionalData: additionalData(input.roomId, input.id) as BufferSource },
      input.key, bytes.subarray(IV_BYTES) as BufferSource,
    )));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!inner || inner.length < SIGNATURE_BYTES) return { ok: false, reason: 'unreadable' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(inner.subarray(SIGNATURE_BYTES));
  } catch {
    return { ok: false, reason: 'invalid text' };
  }
  const raw = fromBase64Url(input.from);
  const publicKey = raw && (await importPublicKey(raw));
  if (!publicKey) return { ok: false, reason: 'bad key' };
  const ok = await verifyBytes(publicKey, inner.subarray(0, SIGNATURE_BYTES), textBindingBytes({ ...input, text }));
  if (!ok) return { ok: false, reason: 'bad signature' };
  // A friend's client keeps to the same rules as the composer; one that does not is not shown.
  if (text.trim().length === 0 || text.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'invalid text' };
  return { ok: true, text };
}
