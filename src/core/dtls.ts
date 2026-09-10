// Binding a call's DTLS certificate to the identity key (ADR 0004).
//
// WebRTC encrypts media with a throwaway DTLS certificate whose fingerprint travels in the
// offer and answer. The server relays those, so a hostile server could swap the fingerprints
// and sit in the middle of every call while both sidebars still show the right identities.
// Each participant therefore signs the fingerprints of its own description with its identity
// key, over the pair of identities involved, and the other side refuses a description whose
// fingerprints were not signed by the identity the server says it came from.
//
// WebCrypto only; runs unchanged in browsers and workerd.
import { fromBase64Url, importPublicKey, signBytes, toBase64Url, verifyBytes } from './identity';

const FINGERPRINT_LINE = /^a=fingerprint:([^\s]+)\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+)\s*$/;
const DOMAIN = 'dave dtls binding v1';

/**
 * Every `a=fingerprint` line of an SDP, as "algorithm HEX" with the algorithm lowercased and the
 * hex uppercased, de-duplicated and sorted. Session- and media-level lines are treated alike.
 */
export function extractDtlsFingerprints(sdp: string): string[] {
  const out = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = FINGERPRINT_LINE.exec(line);
    if (m) out.add(`${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`);
  }
  return [...out].sort();
}

/** The bytes both sides sign and verify. Keys are base64url and fingerprints hex, so newlines are unambiguous separators. */
export function dtlsBindingBytes(from: string, to: string, fingerprints: string[]): Uint8Array {
  return new TextEncoder().encode([DOMAIN, from, to, ...fingerprints].join('\n'));
}

/**
 * Sender side: signature over my description's fingerprints, bound to me and the recipient.
 * Null when the SDP carries no fingerprint (nothing to bind; the receiver will refuse it).
 */
export async function signDescription(input: { privateKey: CryptoKey; from: string; to: string; sdp: string }): Promise<string | null> {
  const fingerprints = extractDtlsFingerprints(input.sdp);
  if (fingerprints.length === 0) return null;
  return toBase64Url(await signBytes(input.privateKey, dtlsBindingBytes(input.from, input.to, fingerprints)));
}

export type DescriptionVerdict = 'ok' | 'unsigned' | 'no fingerprint' | 'bad signature' | 'bad key';

/**
 * Receiver side: does the signature bind this description's fingerprints to the sender's identity
 * and to me? `from` is the public key the server attributed the message to; `to` is my own.
 */
export async function verifyDescription(input: { from: string; to: string; sdp: string; signature: string | undefined }): Promise<DescriptionVerdict> {
  if (!input.signature) return 'unsigned';
  const fingerprints = extractDtlsFingerprints(input.sdp);
  if (fingerprints.length === 0) return 'no fingerprint';
  const raw = fromBase64Url(input.from);
  const publicKey = raw && (await importPublicKey(raw));
  if (!publicKey) return 'bad key';
  const signature = fromBase64Url(input.signature);
  if (!signature) return 'bad signature';
  const ok = await verifyBytes(publicKey, signature, dtlsBindingBytes(input.from, input.to, fingerprints));
  return ok ? 'ok' : 'bad signature';
}
