// Wire protocol shared by client and server. Runtime-neutral: plain data only.
// Binary values (nonces, keys, MACs, signatures) travel as base64url strings.
import { MAX_FILE_BODY_BYTES } from './attachment';

export type Identity = {
  /** Uncompressed P-256 public key, 65 bytes, base64url. This is the participant's identity. */
  publicKey: string;
  /** Six-character human-comparable code derived from the public key. */
  fingerprint: string;
  /** Self-declared display name, 1 to 32 characters. */
  name: string;
  /** Self-declared profile picture: exactly one emoji. Absent means the avatar shows the initial (issue #8). */
  picture?: string;
};

/** Whether a stored value has an identity's fields, as `identityOf` keeps them. */
export const isIdentity = (v: unknown): v is Identity => {
  const i = v as Partial<Identity> | null;
  return !!i && typeof i === 'object' && typeof i.publicKey === 'string' && typeof i.fingerprint === 'string' && typeof i.name === 'string' && (i.picture === undefined || typeof i.picture === 'string');
};
/** The identity in a presence entry, as the Room tags a text with it and a chat line keeps it. */
export const identityOf = ({ publicKey, fingerprint, name, picture }: Identity): Identity => ({ publicKey, fingerprint, name, ...(picture ? { picture } : {}) });

export type Role = 'visitor' | 'participant';

/**
 * A browser's private text key (ADR 0007): the public half of its ECDH P-256 key, 65 bytes, base64url, and its identity's
 * signature over it (core/sealed.ts, `signPrivateTextKey`). Friends seal private texts to it only once they checked the
 * signature, so the server cannot hand out a key of its own.
 */
export type PrivateTextKey = { key: string; sig: string };

/** One attached socket as everyone sees it. This is exactly what the server keeps in the socket attachment. */
export type Person = Identity & {
  role: Role;
  /** Order of joining the Call; null for visitors. */
  joinSeq: number | null;
  sharing: boolean;
  muted: boolean;
  /** Where private texts to this friend are sealed to; none from an app before ADR 0007, which cannot get one. */
  privateTexts?: PrivateTextKey;
};

/** An entry for RTCPeerConnection's iceServers. */
export type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * Opaque WebRTC signaling payload, relayed untouched between two participants. Candidates travel batched.
 * `sig` is the sender's identity signature over the description's DTLS fingerprints (ADR 0004);
 * the server passes it through and only the receiving client checks it.
 * `conn`, `forConn` and `n` go with a description: the sender's connection, the receiver's connection as the sender knows
 * it (absent in a connection's first offer), and the offer's number (an answer repeats the number of the offer it answers).
 * They let a description meant for another connection, or an answer to an older offer, be told apart and dropped
 * (client/call.ts, onSignalNow). They stay outside the signature: a server that rewrites them can only get a description
 * dropped, which blocks a call, and a server can block a call anyway by not relaying it.
 */
export type SignalData = { description?: unknown; sig?: string; candidates?: unknown[]; conn?: string; forConn?: string; n?: number };
const CONN_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_CANDIDATES_PER_MESSAGE = 64;

/**
 * Signaling of a file link (ADR 0006), relayed untouched between any two friends attached to the Room. `link` names the
 * pull's connection, chosen by the friend who pulls; a description is signed like a call's (`sig`, ADR 0004).
 */
export type LinkData = { link: string; description?: unknown; sig?: string; candidates?: unknown[]; busy?: true };

/**
 * Names a `join` or `ice` request; the `call` or `ice` that answers it repeats it, so an answer that comes late (a slow TURN
 * mint) is never taken for the answer to a newer request of the same kind (ticket 47). Optional both ways while the
 * fleet is mixed after a deploy: the server answers a request without one as before, and the client takes an answer
 * without one as the answer to whatever of that kind it waits for.
 */
export type RequestId = number;
const isRequestId = (v: unknown): v is RequestId => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Names a text, chosen at random by its writer; the Room passes it on with the text. A text whose socket was lost before it
 * came back is sent again on the next one, and may have reached the others the first time: they show a writer's text of
 * an id they have shown already no more (ticket 51). Optional both ways, like RequestId: a client from before sends none.
 */
export type TextId = string;
export const isTextId = (v: unknown): v is TextId => typeof v === 'string' && CONN_ID.test(v);

export type ClientMessage =
  /**
   * `authKey` is sent only in answer to a `fresh` challenge: it becomes the room's verifier (ADR 0004).
   * `telemetry` says this browser opted in to PostHog (ticket 32); only then may the server report about this socket there.
   */
  | { t: 'auth'; publicKey: string; name: string; picture?: string; hmac: string; signature: string; authKey?: string; telemetry?: true; privateTexts?: PrivateTextKey }
  /** The PostHog opt-in changed while connected (ticket 32). Only the server keeps it; nobody else learns of it. */
  | { t: 'telemetry'; on: boolean }
  | { t: 'ping' }
  /**
   * A text sealed for the room (ADR 0005, core/sealed.ts): the Room passes it on without reading it. `text` is what clients
   * sent in plain before; the Room refuses it as from an app out of date.
   */
  | { t: 'sealed'; sealed: string; id: TextId }
  /** A file's announcement, sealed like a text under its own domain (ADR 0006); its bytes never come this way. */
  | { t: 'file'; sealed: string; id: TextId }
  /** A private text (ADR 0007), sealed for the one friend `to`: the Room passes it on to them only, and back to me. */
  | { t: 'private'; to: string; sealed: string; id: TextId }
  | { t: 'text'; text: string; id?: TextId }
  /** Enter the Call (or re-declare after a server reconnect). */
  /** `sharing` lets a re-join after a server reconnect keep an ongoing share visible to everyone. */
  /** `id` names the request; the answer repeats it (see RequestId). */
  | { t: 'join'; muted: boolean; sharing?: boolean; id?: RequestId }
  | { t: 'leave' }
  | { t: 'mute'; muted: boolean }
  /** Change the self-declared display name; everyone learns through presence. Texts already sent keep the old one. */
  | { t: 'name'; name: string }
  /** Choose an emoji as the profile picture, or null for none; everyone learns through presence. */
  | { t: 'picture'; picture: string | null }
  /** Point-to-point signaling to another participant, by public key. */
  | { t: 'signal'; to: string; data: SignalData }
  /** Ask for fresh TURN credentials (before an ICE restart with expired ones). */
  | { t: 'ice'; id?: RequestId }
  /** Signaling of a file link to another friend attached to the Room, in the call or not (ADR 0006). */
  | { t: 'link'; to: string; data: LinkData }
  /** Ask for ICE servers for a file link: short-lived TURN credentials, for visitors too. */
  | { t: 'linkice'; id: RequestId }
  /** Announce that my share started or stopped; everyone learns through the presence flag. */
  | { t: 'share'; on: boolean }
  /** Ask a sharer to start or stop sending me their share; `scale` asks for a downscaled encoding (small screens). */
  | { t: 'subscribe'; to: string; on: boolean; scale?: number };

export type ServerMessage =
  /** `fresh`: nobody has entered this room yet, so the answer must carry the auth key derived from the secret. */
  | { t: 'challenge'; nonce: string; fresh?: true }
  | { t: 'welcome'; you: Person }
  | { t: 'presence'; people: Person[] }
  /** A sealed text, tagged with who sent it and when the Room got it. Neither is signed: the text inside is (ADR 0005). */
  | { t: 'sealed'; from: Identity; sealed: string; at: number; id: TextId }
  /** A file's announcement, tagged like a sealed text. */
  | { t: 'file'; from: Identity; sealed: string; at: number; id: TextId }
  /**
   * A private text, to the friend it is for and back to its writer, tagged like a sealed text. `key` is the writer's
   * private text key as the Room has it, so the friend can open it after the writer is gone from presence.
   */
  | { t: 'private'; from: Identity; to: string; key?: PrivateTextKey; sealed: string; at: number; id: TextId }
  /** Reply to join: your place in the Call and the ICE servers to build peer connections with. */
  | { t: 'call'; joinSeq: number; iceServers: IceServer[]; issuedAt: number; id?: RequestId }
  /** A participant left on purpose; peers close that connection at once. A vanished socket only drops out of presence. */
  | { t: 'left'; publicKey: string }
  | { t: 'signal'; from: string; data: SignalData }
  | { t: 'subscribe'; from: string; on: boolean; scale?: number }
  | { t: 'ice'; iceServers: IceServer[]; issuedAt: number; id?: RequestId }
  | { t: 'link'; from: string; data: LinkData }
  | { t: 'linkice'; iceServers: IceServer[]; issuedAt: number; id: RequestId }
  | { t: 'pong' }
  /**
   * `ref` names the client message type that was rejected, when known, so the client can attribute it. `id` names the
   * private text refused (ADR 0007): those do not all go to one friend, so the order alone does not say which.
   */
  | { t: 'error'; reason: string; ref?: ClientMessage['t']; id?: TextId };

/** The exact frames the hibernation auto-response matches, so pings never wake the Room. */
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';
export const PING_INTERVAL_MS = 30_000;

/**
 * Frame cap in UTF-16 units. Sized for signaling, not text (texts, names and pictures have their own caps): a description
 * lists every candidate gathered so far, and one from a friend on a flaky line with many relay and IPv6 candidates went
 * over the old 16 KB and was dropped, so that renegotiation never arrived (ticket 30). Well under Cloudflare's frame limit.
 */
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const MAX_NAME_LENGTH = 32;
export const MAX_TEXT_LENGTH = 2000;
/** Longest RGI emoji is a four-person family: 7 code points, 11 UTF-16 units. A little slack for a variation selector. */
export const MAX_PICTURE_LENGTH = 16;
/**
 * The longest sealed text a client writes, base64url (core/sealed.ts): iv, then signature, text, and padding to a multiple of
 * 256 bytes, then the tag. A UTF-16 unit is at most three UTF-8 bytes (a pair is four for two units, a lone surrogate
 * becomes U+FFFD). The Room refuses longer ones without reading them.
 */
export const MAX_SEALED_LENGTH = Math.ceil(((12 + Math.ceil((64 + 3 * MAX_TEXT_LENGTH + 1) / 256) * 256 + 16) * 4) / 3);
/** The longest sealed file announcement a client writes, the same way: its body is JSON of at most MAX_FILE_BODY_BYTES. */
export const MAX_SEALED_FILE_LENGTH = Math.ceil(((12 + Math.ceil((64 + MAX_FILE_BODY_BYTES + 1) / 256) * 256 + 16) * 4) / 3);
/** What the Room answers a plain text with: only an app from before ADR 0005 sends one. */
export const OUT_OF_DATE = 'this app is out of date, reload the page to send';

/** Close codes the server uses. 4000 to 4999 are application-defined. */
export const CLOSE_AUTH_FAILED = 4001;
/** This identity opened a newer socket (another tab, or a reconnect whose old socket the server had not noticed). */
export const CLOSE_SUPERSEDED = 4004;

const B64URL = /^[A-Za-z0-9_-]+$/;
const str = (v: unknown, max = MAX_MESSAGE_BYTES): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const b64 = (v: unknown): v is string => str(v, 1024) && B64URL.test(v);

export function normaliseName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH ? name : null;
}

/** One emoji exactly: a single RGI emoji as Unicode defines it (flags, skin tones and ZWJ families included), nothing around it. */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
export function isSingleEmoji(s: string): boolean {
  return RGI_EMOJI.test(s);
}

/** A profile picture as sent: trimmed; null when it is not exactly one emoji. */
export function normalisePicture(raw: string): string | null {
  const picture = raw.trim();
  return picture.length <= MAX_PICTURE_LENGTH && isSingleEmoji(picture) ? picture : null;
}

/** Not a wire message: the parser's way of saying why a frame was rejected, and of which type it claimed to be when that is known. */
export type Invalid = { t: 'invalid'; reason: string; ref?: ClientMessage['t']; id?: TextId };
const invalid = (reason: string): Invalid => ({ t: 'invalid', reason });

const CLIENT_TYPES: ReadonlySet<string> = new Set<ClientMessage['t']>(['auth', 'ping', 'sealed', 'file', 'private', 'link', 'linkice', 'text', 'join', 'leave', 'mute', 'name', 'picture', 'signal', 'ice', 'share', 'subscribe', 'telemetry']);
const isClientType = (v: unknown): v is ClientMessage['t'] => typeof v === 'string' && CLIENT_TYPES.has(v);

/**
 * A rejected frame carries the type it claimed, so the sender can tell a dropped text from a dropped signal (ticket 30:
 * an oversized signal showed as "Not sent" in the chat). A frame too large to parse is read by its prefix; the client's
 * JSON.stringify always writes `t` first.
 */
export function parseClientMessage(raw: unknown): ClientMessage | Invalid {
  if (typeof raw === 'string' && raw.length > MAX_MESSAGE_BYTES) {
    const claimed = /^\{"t":"([a-z]+)"/.exec(raw.slice(0, 32))?.[1];
    return isClientType(claimed) ? { ...invalid('message too large'), ref: claimed } : invalid('message too large');
  }
  const parsed = parseFrame(raw);
  if (parsed.t !== 'invalid') return parsed;
  const claimed = typeof raw === 'string' ? safeType(raw) : undefined;
  return isClientType(claimed) ? { ...parsed, ref: claimed } : parsed;
}

function safeType(raw: string): unknown {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && 't' in v ? v.t : undefined;
  } catch {
    return undefined;
  }
}

function parseFrame(raw: unknown): ClientMessage | Invalid {
  if (typeof raw !== 'string') return invalid('unrecognised message');
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
      if (m.authKey !== undefined && !(b64(m.authKey) && m.authKey.length === 43)) return invalid('unrecognised message');
      const name = normaliseName(m.name);
      if (!name) return invalid('invalid name');
      const auth: Extract<ClientMessage, { t: 'auth' }> = { t: 'auth', publicKey: m.publicKey, name, hmac: m.hmac, signature: m.signature };
      if (m.picture !== undefined && m.picture !== null) {
        if (!str(m.picture, 64)) return invalid('unrecognised message');
        const picture = normalisePicture(m.picture);
        if (!picture) return invalid('invalid picture');
        auth.picture = picture;
      }
      if (typeof m.authKey === 'string') auth.authKey = m.authKey;
      if (m.telemetry === true) auth.telemetry = true;
      // Optional: one of another shape is left out, so the friend still gets in, without private texts (ADR 0007).
      const k = m.privateTexts as Record<string, unknown> | null | undefined;
      if (k && typeof k === 'object' && b64(k.key) && k.key.length === 87 && b64(k.sig) && k.sig.length === 86) auth.privateTexts = { key: k.key, sig: k.sig };
      return auth;
    }
    case 'ping':
      return { t: 'ping' };
    case 'join':
      if (typeof m.muted !== 'boolean' || (m.id !== undefined && !isRequestId(m.id))) return invalid('unrecognised message');
      return isRequestId(m.id) ? { t: 'join', muted: m.muted, sharing: m.sharing === true, id: m.id } : { t: 'join', muted: m.muted, sharing: m.sharing === true };
    case 'leave':
      return { t: 'leave' };
    case 'mute':
      return typeof m.muted === 'boolean' ? { t: 'mute', muted: m.muted } : invalid('unrecognised message');
    case 'name': {
      if (!str(m.name, 256)) return invalid('unrecognised message');
      const name = normaliseName(m.name);
      return name ? { t: 'name', name } : invalid('invalid name');
    }
    case 'picture': {
      if (m.picture === null) return { t: 'picture', picture: null };
      if (!str(m.picture, 64)) return invalid('unrecognised message');
      const picture = normalisePicture(m.picture);
      return picture ? { t: 'picture', picture } : invalid('invalid picture');
    }
    case 'ice':
      if (m.id !== undefined && !isRequestId(m.id)) return invalid('unrecognised message');
      return isRequestId(m.id) ? { t: 'ice', id: m.id } : { t: 'ice' };
    case 'share':
      return typeof m.on === 'boolean' ? { t: 'share', on: m.on } : invalid('unrecognised message');
    case 'telemetry':
      return typeof m.on === 'boolean' ? { t: 'telemetry', on: m.on } : invalid('unrecognised message');
    case 'subscribe': {
      if (!b64(m.to) || typeof m.on !== 'boolean') return invalid('unrecognised message');
      const scale = typeof m.scale === 'number' && m.scale >= 1 && m.scale <= 4 ? m.scale : undefined;
      return scale ? { t: 'subscribe', to: m.to, on: m.on, scale } : { t: 'subscribe', to: m.to, on: m.on };
    }
    case 'signal': {
      if (!b64(m.to) || typeof m.data !== 'object' || m.data === null) return invalid('unrecognised message');
      const d = m.data as Record<string, unknown>;
      const data: SignalData = {};
      if ('description' in d) {
        data.description = d.description;
        if ('sig' in d) {
          if (!b64(d.sig)) return invalid('unrecognised message');
          data.sig = d.sig;
        }
        for (const k of ['conn', 'forConn'] as const) {
          if (!(k in d)) continue;
          const id = d[k];
          if (typeof id !== 'string' || !CONN_ID.test(id)) return invalid('unrecognised message');
          data[k] = id;
        }
        if ('n' in d) {
          if (!Number.isSafeInteger(d.n) || (d.n as number) < 0) return invalid('unrecognised message');
          data.n = d.n as number;
        }
      }
      if ('candidates' in d) {
        if (!Array.isArray(d.candidates) || d.candidates.length > MAX_CANDIDATES_PER_MESSAGE) return invalid('unrecognised message');
        data.candidates = d.candidates;
      }
      if (!('description' in data) && !('candidates' in data)) return invalid('unrecognised message');
      return { t: 'signal', to: m.to, data };
    }
    case 'sealed':
      if (!isTextId(m.id) || typeof m.sealed !== 'string' || !B64URL.test(m.sealed)) return invalid('unrecognised message');
      if (m.sealed.length > MAX_SEALED_LENGTH) return invalid(`message longer than ${MAX_TEXT_LENGTH} characters`);
      return { t: 'sealed', sealed: m.sealed, id: m.id };
    case 'file':
      if (!isTextId(m.id) || typeof m.sealed !== 'string' || !B64URL.test(m.sealed)) return invalid('unrecognised message');
      if (m.sealed.length > MAX_SEALED_FILE_LENGTH) return invalid('file description too long');
      return { t: 'file', sealed: m.sealed, id: m.id };
    case 'private':
      if (!isTextId(m.id)) return invalid('unrecognised message');
      // Refused by its id from here on: the writer's app goes by it (client/room.ts).
      if (!b64(m.to) || typeof m.sealed !== 'string' || !B64URL.test(m.sealed)) return { ...invalid('unrecognised message'), ref: 'private', id: m.id };
      if (m.sealed.length > MAX_SEALED_LENGTH) return { ...invalid(`message longer than ${MAX_TEXT_LENGTH} characters`), ref: 'private', id: m.id };
      return { t: 'private', to: m.to, sealed: m.sealed, id: m.id };
    case 'link': {
      if (!b64(m.to) || typeof m.data !== 'object' || m.data === null) return invalid('unrecognised message');
      const d = m.data as Record<string, unknown>;
      if (typeof d.link !== 'string' || !CONN_ID.test(d.link)) return invalid('unrecognised message');
      const data: LinkData = { link: d.link };
      if ('description' in d) {
        data.description = d.description;
        if ('sig' in d) {
          if (!b64(d.sig)) return invalid('unrecognised message');
          data.sig = d.sig;
        }
      }
      if ('candidates' in d) {
        if (!Array.isArray(d.candidates) || d.candidates.length > MAX_CANDIDATES_PER_MESSAGE) return invalid('unrecognised message');
        data.candidates = d.candidates;
      }
      // A holder at her limit says so instead of nothing, and the puller asks again later (attachments ticket 05).
      if (d.busy === true) data.busy = true;
      if (!('description' in data) && !('candidates' in data) && !data.busy) return invalid('unrecognised message');
      return { t: 'link', to: m.to, data };
    }
    case 'linkice':
      return isRequestId(m.id) ? { t: 'linkice', id: m.id } : invalid('unrecognised message');
    case 'text':
      return invalid(OUT_OF_DATE);
    default:
      return invalid('unrecognised message');
  }
}
