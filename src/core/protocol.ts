// Wire protocol shared by client and server. Runtime-neutral: plain data only.
// Binary values (nonces, keys, MACs, signatures) travel as base64url strings.

export type Identity = {
  /** Uncompressed P-256 public key, 65 bytes, base64url. This is the participant's identity. */
  publicKey: string;
  /** Six-character human-comparable code derived from the public key. */
  fingerprint: string;
  /** Self-declared display name, 1 to 32 characters. */
  name: string;
};

export type ClientMessage =
  | { t: 'auth'; publicKey: string; name: string; hmac: string; signature: string }
  | { t: 'ping' }
  | { t: 'echo'; text: string };

export type ServerMessage =
  | { t: 'challenge'; nonce: string }
  | { t: 'welcome'; you: Identity }
  | { t: 'pong' }
  | { t: 'echo'; text: string }
  | { t: 'error'; reason: string };

export const MAX_MESSAGE_BYTES = 4096;
export const MAX_NAME_LENGTH = 32;

/** Close codes the server uses. 4000 to 4999 are application-defined. */
export const CLOSE_AUTH_FAILED = 4001;
export const CLOSE_NOT_CONFIGURED = 4002;

const B64URL = /^[A-Za-z0-9_-]+$/;
const str = (v: unknown, max = MAX_MESSAGE_BYTES): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const b64 = (v: unknown): v is string => str(v, 1024) && B64URL.test(v);

export function normaliseName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('t' in value)) return null;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'auth': {
      if (!b64(m.publicKey) || !b64(m.hmac) || !b64(m.signature) || !str(m.name, 256)) return null;
      const name = normaliseName(m.name);
      return name ? { t: 'auth', publicKey: m.publicKey, name, hmac: m.hmac, signature: m.signature } : null;
    }
    case 'ping':
      return { t: 'ping' };
    case 'echo':
      return typeof m.text === 'string' ? { t: 'echo', text: m.text } : null;
    default:
      return null;
  }
}
