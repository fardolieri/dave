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

export type Role = 'visitor' | 'participant';

/** One attached socket as everyone sees it. This is exactly what the server keeps in the socket attachment. */
export type Person = Identity & {
  role: Role;
  /** Order of joining the Call; null for visitors. */
  joinSeq: number | null;
  sharing: boolean;
  muted: boolean;
};

/** An entry for RTCPeerConnection's iceServers. */
export type IceServer = { urls: string | string[]; username?: string; credential?: string };

/** Opaque WebRTC signaling payload, relayed untouched between two participants. Candidates travel batched. */
export type SignalData = { description?: unknown; candidates?: unknown[] };
export const MAX_CANDIDATES_PER_MESSAGE = 64;

export type ClientMessage =
  | { t: 'auth'; publicKey: string; name: string; hmac: string; signature: string }
  | { t: 'ping' }
  | { t: 'text'; text: string }
  /** Enter the Call (or re-declare after a server reconnect). */
  /** `sharing` lets a re-join after a server reconnect keep an ongoing share visible to everyone. */
  | { t: 'join'; muted: boolean; sharing?: boolean }
  | { t: 'leave' }
  | { t: 'mute'; muted: boolean }
  /** Point-to-point signaling to another participant, by public key. */
  | { t: 'signal'; to: string; data: SignalData }
  /** Ask for fresh TURN credentials (before an ICE restart with expired ones). */
  | { t: 'ice' }
  /** Announce that my share started or stopped; everyone learns through the presence flag. */
  | { t: 'share'; on: boolean }
  /** Ask a sharer to start or stop sending me their share; `scale` asks for a downscaled encoding (small screens). */
  | { t: 'subscribe'; to: string; on: boolean; scale?: number };

export type ServerMessage =
  | { t: 'challenge'; nonce: string }
  | { t: 'welcome'; you: Person }
  | { t: 'presence'; people: Person[] }
  | { t: 'text'; from: Identity; text: string; at: number }
  /** Reply to join: your place in the Call and the ICE servers to build peer connections with. */
  | { t: 'call'; joinSeq: number; iceServers: IceServer[]; issuedAt: number }
  /** A participant left on purpose; peers close that connection at once. A vanished socket only drops out of presence. */
  | { t: 'left'; publicKey: string }
  | { t: 'signal'; from: string; data: SignalData }
  | { t: 'subscribe'; from: string; on: boolean; scale?: number }
  | { t: 'ice'; iceServers: IceServer[]; issuedAt: number }
  | { t: 'pong' }
  /** `ref` names the client message type that was rejected, when known, so the client can attribute it. */
  | { t: 'error'; reason: string; ref?: ClientMessage['t'] };

/** The exact frames the hibernation auto-response matches, so pings never wake the Room. */
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';
export const PING_INTERVAL_MS = 30_000;

/** Frame cap in UTF-16 units. Generous so a 2,000-character text survives JSON escaping. */
export const MAX_MESSAGE_BYTES = 16384;
export const MAX_NAME_LENGTH = 32;
export const MAX_TEXT_LENGTH = 2000;

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

/** Not a wire message: the parser's way of saying why a frame was rejected. */
export type Invalid = { t: 'invalid'; reason: string };
const invalid = (reason: string): Invalid => ({ t: 'invalid', reason });

export function parseClientMessage(raw: unknown): ClientMessage | Invalid {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return invalid('unrecognised message');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid('unrecognised message');
  }
  if (typeof value !== 'object' || value === null || !('t' in value)) return invalid('unrecognised message');
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'auth': {
      if (!b64(m.publicKey) || !b64(m.hmac) || !b64(m.signature) || !str(m.name, 256)) return invalid('unrecognised message');
      const name = normaliseName(m.name);
      return name ? { t: 'auth', publicKey: m.publicKey, name, hmac: m.hmac, signature: m.signature } : invalid('invalid name');
    }
    case 'ping':
      return { t: 'ping' };
    case 'join':
      return typeof m.muted === 'boolean' ? { t: 'join', muted: m.muted, sharing: m.sharing === true } : invalid('unrecognised message');
    case 'leave':
      return { t: 'leave' };
    case 'mute':
      return typeof m.muted === 'boolean' ? { t: 'mute', muted: m.muted } : invalid('unrecognised message');
    case 'ice':
      return { t: 'ice' };
    case 'share':
      return typeof m.on === 'boolean' ? { t: 'share', on: m.on } : invalid('unrecognised message');
    case 'subscribe': {
      if (!b64(m.to) || typeof m.on !== 'boolean') return invalid('unrecognised message');
      const scale = typeof m.scale === 'number' && m.scale >= 1 && m.scale <= 4 ? m.scale : undefined;
      return scale ? { t: 'subscribe', to: m.to, on: m.on, scale } : { t: 'subscribe', to: m.to, on: m.on };
    }
    case 'signal': {
      if (!b64(m.to) || typeof m.data !== 'object' || m.data === null) return invalid('unrecognised message');
      const d = m.data as Record<string, unknown>;
      const data: SignalData = {};
      if ('description' in d) data.description = d.description;
      if ('candidates' in d) {
        if (!Array.isArray(d.candidates) || d.candidates.length > MAX_CANDIDATES_PER_MESSAGE) return invalid('unrecognised message');
        data.candidates = d.candidates;
      }
      if (!('description' in data) && !('candidates' in data)) return invalid('unrecognised message');
      return { t: 'signal', to: m.to, data };
    }
    case 'text': {
      if (typeof m.text !== 'string') return invalid('unrecognised message');
      const text = m.text.trim();
      if (text.length === 0) return invalid('empty message');
      if (text.length > MAX_TEXT_LENGTH) return invalid(`message longer than ${MAX_TEXT_LENGTH} characters`);
      return { t: 'text', text };
    }
    default:
      return invalid('unrecognised message');
  }
}
