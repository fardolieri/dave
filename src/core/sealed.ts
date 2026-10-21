// Sealed texts (ADR 0005). A text leaves the writer's browser encrypted with the room's text key, which is derived from
// the shared secret and never reaches the server, and signed with the writer's identity key inside the encryption. The
// Room relays (and later stores) what it cannot read; a friend opens it and checks that the identity the server says it
// came from wrote it, for this room and under this id.
//
// Inside: signature (64 bytes) || UTF-8 text || 0x80 || zeros up to a multiple of 256 bytes, so the length on the wire
// says little. Outside: iv (12 bytes) || AES-GCM ciphertext and tag, base64url. The additional data binds the room and
// the id, so a sealed text cannot be passed off in another room or under another id.
//
// An attachment's announcement (ADR 0006) is sealed the same way under its own domain, `dave file v1`: its body is the
// file's description as JSON (core/attachment.ts), so a text cannot be passed off as a file or a file as a text.
//
// A private text (ADR 0007) is sealed the same way under `dave private v1` (a file's announcement for one friend under
// `dave private file v1`), with the one friend it is for in the signed
// bytes and the additional data, and under a key only the two of them have: ECDH between the private text keys of the
// two browsers (`sharedPrivateTextKey`), each browser's own and published signed by its identity key (`signPrivateTextKey`).
//
// WebCrypto only; runs unchanged in browsers, workerd and Node.
import { fromBase64Url, importPublicKey, signBytes, toBase64Url, verifyBytes } from './identity';
import { MAX_TEXT_LENGTH } from './protocol';
import { MAX_FILE_BODY_BYTES, parseFileMeta, type FileMeta } from './attachment';

const DOMAIN = 'dave text v1';
const FILE_DOMAIN = 'dave file v1';
const PRIVATE_DOMAIN = 'dave private v1';
const PRIVATE_FILE_DOMAIN = 'dave private file v1';
const PRIVATE_TEXT_KEY_DOMAIN = 'dave private text key v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SIGNATURE_BYTES = 64; // ECDSA P-256 as WebCrypto writes it: r || s
const BUCKET = 256;

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * The bytes the writer signs and every friend verifies. Keys, room ids and text ids hold no newline; the text comes last.
 * `to`, the friend a private text is for, only in a private text's.
 */
export function textBindingBytes(input: { roomId: string; id: string; from: string; to?: string; text: string }, domain = DOMAIN): Uint8Array {
  return utf8([domain, input.roomId, input.id, input.from, ...(input.to === undefined ? [] : [input.to]), input.text].join('\n'));
}

const additionalData = (roomId: string, id: string, domain = DOMAIN, to?: string) => utf8([domain, roomId, id, ...(to === undefined ? [] : [to])].join('\n'));

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
export function sealText(input: { key: CryptoKey; privateKey: CryptoKey; roomId: string; id: string; from: string; text: string }): Promise<string> {
  return seal(input, DOMAIN);
}

/** Writer side: a file's announcement sealed for this room, signed by `from`. */
export function sealFile(input: { key: CryptoKey; privateKey: CryptoKey; roomId: string; id: string; from: string; file: FileMeta }): Promise<string> {
  return seal({ ...input, text: JSON.stringify(input.file) }, FILE_DOMAIN);
}

/**
 * Writer side: a private text sealed for the one friend `to` (their identity's public key), with the key the two share
 * (`sharedPrivateTextKey`), signed by `from`.
 */
export function sealPrivate(input: { key: CryptoKey; privateKey: CryptoKey; roomId: string; id: string; from: string; to: string; text: string }): Promise<string> {
  return seal(input, PRIVATE_DOMAIN);
}

/** Writer side: a file's announcement for the one friend `to` (ADR 0006, 0007), sealed like a private text. */
export function sealPrivateFile(input: { key: CryptoKey; privateKey: CryptoKey; roomId: string; id: string; from: string; to: string; file: FileMeta }): Promise<string> {
  return seal({ ...input, text: JSON.stringify(input.file) }, PRIVATE_FILE_DOMAIN);
}

async function seal(input: { key: CryptoKey; privateKey: CryptoKey; roomId: string; id: string; from: string; to?: string; text: string }, domain: string): Promise<string> {
  const signature = await signBytes(input.privateKey, textBindingBytes(input, domain));
  const text = utf8(input.text);
  const inner = new Uint8Array(signature.length + text.length);
  inner.set(signature);
  inner.set(text, signature.length);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(input.roomId, input.id, domain, input.to) as BufferSource }, input.key, pad(inner) as BufferSource,
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
  const opened = await open(input, DOMAIN);
  if (!opened.ok) return opened;
  // A friend's client keeps to the same rules as the composer; one that does not is not shown.
  if (opened.text.trim().length === 0 || opened.text.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'invalid text' };
  return opened;
}

export type OpenedFile = { ok: true; file: FileMeta } | { ok: false; reason: 'unreadable' | 'bad signature' | 'bad key' | 'invalid file' };

/** Reader side: a file's announcement, on the same terms as a text's. One that does not describe a file is refused. */
export async function openFile(input: { key: CryptoKey; roomId: string; id: string; from: string; sealed: string }): Promise<OpenedFile> {
  const opened = await open(input, FILE_DOMAIN);
  if (!opened.ok) return { ok: false, reason: opened.reason === 'invalid text' ? 'invalid file' : opened.reason };
  let file: FileMeta | null = null;
  try {
    file = opened.text.length <= MAX_FILE_BODY_BYTES ? parseFileMeta(JSON.parse(opened.text)) : null;
  } catch { /* not JSON */ }
  return file ? { ok: true, file } : { ok: false, reason: 'invalid file' };
}

/**
 * Reader side: a private text, if it was sealed for `to` with the key `to` shares with `from`, under this room and id,
 * and signed by `from`. On the same terms as a text's otherwise.
 */
export async function openPrivate(input: { key: CryptoKey; roomId: string; id: string; from: string; to: string; sealed: string }): Promise<OpenedText> {
  const opened = await open(input, PRIVATE_DOMAIN);
  if (!opened.ok) return opened;
  if (opened.text.trim().length === 0 || opened.text.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'invalid text' };
  return opened;
}

/** Reader side: a file's announcement for `to`, on the same terms as a private text's. */
export async function openPrivateFile(input: { key: CryptoKey; roomId: string; id: string; from: string; to: string; sealed: string }): Promise<OpenedFile> {
  const opened = await open(input, PRIVATE_FILE_DOMAIN);
  if (!opened.ok) return { ok: false, reason: opened.reason === 'invalid text' ? 'invalid file' : opened.reason };
  let file: FileMeta | null = null;
  try {
    file = opened.text.length <= MAX_FILE_BODY_BYTES ? parseFileMeta(JSON.parse(opened.text)) : null;
  } catch { /* not JSON */ }
  return file ? { ok: true, file } : { ok: false, reason: 'invalid file' };
}

async function open(input: { key: CryptoKey; roomId: string; id: string; from: string; to?: string; sealed: string }, domain: string): Promise<OpenedText> {
  const bytes = fromBase64Url(input.sealed);
  if (!bytes || bytes.length < IV_BYTES + TAG_BYTES + BUCKET) return { ok: false, reason: 'unreadable' };
  let inner: Uint8Array | null;
  try {
    inner = unpad(new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) as BufferSource, additionalData: additionalData(input.roomId, input.id, domain, input.to) as BufferSource },
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
  const ok = await verifyBytes(publicKey, inner.subarray(0, SIGNATURE_BYTES), textBindingBytes({ ...input, text }, domain));
  if (!ok) return { ok: false, reason: 'bad signature' };
  return { ok: true, text };
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** Client side: this browser's key for private texts, an ECDH P-256 keypair whose private half never leaves it. */
export function generatePrivateTextKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH, false, ['deriveBits']) as Promise<CryptoKeyPair>;
}

const privateTextKeyBytes = (identity: string, key: string) => utf8([PRIVATE_TEXT_KEY_DOMAIN, identity, key].join('\n'));

/**
 * The identity's signature over its key for private texts, so a server that hands out another key in its place is
 * found out: friends seal private texts only to a key its identity signed (`verifyPrivateTextKey`).
 */
export async function signPrivateTextKey(input: { privateKey: CryptoKey; identity: string; key: string }): Promise<string> {
  return toBase64Url(await signBytes(input.privateKey, privateTextKeyBytes(input.identity, input.key)));
}

/** Whether `key` is the key for private texts that `identity` signed, and a valid P-256 point. */
export async function verifyPrivateTextKey(input: { identity: string; key: string; sig: string }): Promise<boolean> {
  const raw = fromBase64Url(input.identity);
  const signature = fromBase64Url(input.sig);
  const publicKey = raw && (await importPublicKey(raw));
  if (!publicKey || !signature || !(await importPrivateTextKey(input.key))) return false;
  return verifyBytes(publicKey, signature, privateTextKeyBytes(input.identity, input.key));
}

async function importPrivateTextKey(key: string): Promise<CryptoKey | null> {
  const raw = fromBase64Url(key);
  if (!raw || raw.length !== 65 || raw[0] !== 0x04) return null;
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, ECDH, true, []);
  } catch {
    return null;
  }
}

/**
 * The AES-GCM key two friends share for their private texts: ECDH between my private key and their public one, through
 * HKDF bound to both identities, in an order both sides agree on. The same both ways. Null for a key that is no point.
 */
export async function sharedPrivateTextKey(input: { mine: CryptoKey; theirs: string; me: string; them: string }): Promise<CryptoKey | null> {
  const theirs = await importPrivateTextKey(input.theirs);
  if (!theirs) return null;
  // Workers types spell the field `$public`; every runtime takes `public`.
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs } as unknown as Parameters<SubtleCrypto['deriveBits']>[0], input.mine, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const pair = [input.me, input.them].sort().join('\n');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32) as BufferSource, info: utf8(`${PRIVATE_DOMAIN}\n${pair}`) as BufferSource },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
