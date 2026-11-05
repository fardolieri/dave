// Wire protocol shared by client and server. Runtime-neutral: plain data only.
// Binary values (nonces, keys, MACs, signatures) travel as base64url strings.
import { MAX_FILE_BODY_BYTES } from './attachment';
import { KEPT_PIECE_BYTES, KEPT_PIECES_MAX } from './kept';

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

/**
 * An identity as the server has it (ADR 0010): the key and its fingerprint, and the friend's profile sealed with the room's
 * text key (core/sealed.ts, `sealProfile`), which it cannot read. A friend's app opens it into an `Identity`.
 */
export type WireIdentity = { publicKey: string; fingerprint: string; profile: string };
export const wireIdentityOf = ({ publicKey, fingerprint, profile }: WireIdentity): WireIdentity => ({ publicKey, fingerprint, profile });

/** Whether two identities show the same: the same key, under the same name and picture. */
export const sameIdentity = (a: Identity, b: Identity): boolean => a.publicKey === b.publicKey && a.fingerprint === b.fingerprint && a.name === b.name && a.picture === b.picture;

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

/** One attached socket as everyone sees it, its profile opened (client/room.ts). */
export type Person = Identity & PresenceState;
/** One attached socket as the server keeps it in the socket attachment and lists it in presence: its profile sealed. */
export type WirePerson = WireIdentity & PresenceState;
export type PresenceState = {
  role: Role;
  /** Order of joining the Call; null for visitors. */
  joinSeq: number | null;
  sharing: boolean;
  /** Who watches the share, as the sharer declares it (a subscribe reaches only the sharer's browser); absent while not sharing. */
  viewers?: string[];
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
  | { t: 'auth'; publicKey: string; profile: string; hmac: string; signature: string; authKey?: string; telemetry?: true; privateTexts?: PrivateTextKey }
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
  | { t: 'text'; text: string; id?: TextId }
  /**
   * A piece of a file I sent (ADR 0009), sealed with the room's text key (core/sealed.ts, `sealPiece`), for the server to
   * keep for friends who cannot pull it from anyone online. Answered with `kept`.
   */
  | { t: 'piece'; hash: string; n: number; sealed: string }
  /** Ask for a piece of a file the server keeps; the answer is a `piece` frame. */
  | { t: 'fetch'; hash: string; n: number }
  /**
   * Ask for the room's texts and file announcements the server keeps (ADR 0009) that it took after `since` (the Room's
   * clock, ms), the newest SYNC_MAX of them. Asked after every welcome; the answer is one or more `history` frames.
   */
  | { t: 'sync'; since: number }
  /** Enter the Call (or re-declare after a server reconnect). */
  /** `sharing` lets a re-join after a server reconnect keep an ongoing share visible to everyone. */
  /** `id` names the request; the answer repeats it (see RequestId). */
  | { t: 'join'; muted: boolean; sharing?: boolean; id?: RequestId }
  | { t: 'leave' }
  | { t: 'mute'; muted: boolean }
  /**
   * My profile changed (a new name or picture), sealed again for this room (ADR 0010); everyone learns through presence.
   * Texts already sent keep the old one.
   */
  | { t: 'profile'; profile: string }
  /** Point-to-point signaling to another participant, by public key. */
  | { t: 'signal'; to: string; data: SignalData }
  /** Ask for fresh TURN credentials (before an ICE restart with expired ones). */
  | { t: 'ice'; id?: RequestId }
  /** Signaling of a file link to another friend attached to the Room, in the call or not (ADR 0006). */
  | { t: 'link'; to: string; data: LinkData }
  /** Ask for ICE servers for a file link: short-lived TURN credentials, for visitors too. */
  | { t: 'linkice'; id: RequestId }
  /**
   * Announce that my share started or stopped; everyone learns through the presence flag. `viewers`: who watches it now,
   * which everyone learns too, so a viewer sees who else watches. Without it (an app from before) the last list stays.
   */
  | { t: 'share'; on: boolean; viewers?: string[] }
  /** Ask a sharer to start or stop sending me their share; `scale` asks for a downscaled encoding (small screens). */
  | { t: 'subscribe'; to: string; on: boolean; scale?: number };

/** A text or a file's announcement as the Room broadcast it, and as the server keeps it for those who were away (ADR 0009). */
export type KeptEntry = { t: 'sealed' | 'file'; from: WireIdentity; sealed: string; at: number; id: TextId };

export type ServerMessage =
  /** `fresh`: nobody has entered this room yet, so the answer must carry the auth key derived from the secret. */
  | { t: 'challenge'; nonce: string; fresh?: true }
  | { t: 'welcome'; you: WirePerson }
  | { t: 'presence'; people: WirePerson[] }
  /**
   * A sealed text, tagged with who sent it (their key, and their profile sealed as it was then) and when the Room got it.
   * The tag is not signed: the text inside is (ADR 0005), and so is the profile (ADR 0010).
   */
  | { t: 'sealed'; from: WireIdentity; sealed: string; at: number; id: TextId }
  /** A file's announcement, tagged like a sealed text. */
  | { t: 'file'; from: WireIdentity; sealed: string; at: number; id: TextId }
  /**
   * What the server keeps of this room (ADR 0009), as each frame was broadcast, oldest first: the answer to a `sync`, in
   * frames of at most SYNC_FRAME_BYTES. On the answer's last frame, `upTo`: the Room's clock when it asked; everything
   * kept before is in the answer (the newest SYNC_MAX of it), and what comes after comes live. `unavailable` instead,
   * with no entries, when the server could not say (its daily share used up, the Store failing): not that nothing came.
   */
  | { t: 'history'; entries: KeptEntry[]; last?: true; upTo?: number; unavailable?: true }
  /** A piece of a kept file, as sealed: the answer to a `fetch`. Without `sealed` when the server does not have it (any more). */
  | { t: 'piece'; hash: string; n: number; sealed?: string }
  /**
   * Whether the server keeps a piece sent up. Not `ok`: with `again` when it failed for a moment, and may keep it if sent
   * again; without, when it will not today (its daily share used up).
   */
  | { t: 'kept'; hash: string; n: number; ok: boolean; again?: true }
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
  | { t: 'error'; reason: string; ref?: RefType; id?: TextId };

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
/** The most viewers a share declares; far more than a call of friends holds. */
export const MAX_VIEWERS = 32;
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
/**
 * Why a name or picture in plain is refused: only an app from before ADR 0010 sends one. A `name` or `picture` message is
 * answered with it; an auth is not answered, but closed with CLOSE_OUT_OF_DATE.
 */
export const APP_OUT_OF_DATE = 'this app is out of date, reload the page';
/**
 * The longest sealed profile a client writes, as MAX_SEALED_LENGTH: its body is JSON of a name and a picture, each
 * character escaped at worst to six bytes, and the JSON around them.
 */
export const MAX_SEALED_PROFILE_LENGTH = Math.ceil(((12 + Math.ceil((64 + 6 * (MAX_NAME_LENGTH + MAX_PICTURE_LENGTH) + 32 + 1) / 256) * 256 + 16) * 4) / 3);

/** Close codes the server uses. 4000 to 4999 are application-defined. */
export const CLOSE_AUTH_FAILED = 4001;
/** This identity opened a newer socket (another tab, or a reconnect whose old socket the server had not noticed). */
export const CLOSE_SUPERSEDED = 4004;
/**
 * An app from before ADR 0010 answered the challenge with its name in plain. Closed, not refused: such an app takes a
 * refusal for a wrong invite link and stops for good, but tries a closed socket again, quietly, until its update bar
 * (which a deploy brings within minutes) has it reloaded.
 */
export const CLOSE_OUT_OF_DATE = 4006;

const B64URL = /^[A-Za-z0-9_-]+$/;
const str = (v: unknown, max = MAX_MESSAGE_BYTES): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const b64 = (v: unknown): v is string => str(v, 1024) && B64URL.test(v);
/** An identity's public key: 65 bytes, base64url. A list of them stays well inside a socket attachment's 16 KB. */
const isPublicKey = (v: unknown): v is string => b64(v) && v.length === 87;
/** Whether a text is an identity's public key as the wire writes one: 65 bytes, base64url. */
export const isPublicKeyText = isPublicKey;

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

/**
 * What a refusal names: a message type, or one an app before ADR 0010 sent (a name or picture in plain), or before
 * ADR 0011 (a private text routed to a friend by key).
 */
export type RefType = ClientMessage['t'] | 'name' | 'picture' | 'private';
/** Not a wire message: the parser's way of saying why a frame was rejected, and of which type it claimed to be when that is known. */
export type Invalid = { t: 'invalid'; reason: string; ref?: RefType; id?: TextId };
const invalid = (reason: string): Invalid => ({ t: 'invalid', reason });

const CLIENT_TYPES: ReadonlySet<string> = new Set<ClientMessage['t']>(['auth', 'ping', 'sealed', 'file', 'link', 'linkice', 'text', 'join', 'leave', 'mute', 'profile', 'signal', 'ice', 'share', 'subscribe', 'telemetry', 'sync', 'piece', 'fetch']);
/** A file's SHA-256, base64url, as an announcement names it (core/attachment.ts). */
const isFileHash = (v: unknown): v is string => typeof v === 'string' && v.length === 43 && B64URL.test(v);
const isPieceIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < KEPT_PIECES_MAX;
/** The longest piece a client sends, sealed and base64url: a whole piece, the iv and the tag. */
export const MAX_SEALED_PIECE_LENGTH = Math.ceil(((12 + KEPT_PIECE_BYTES + 16) * 4) / 3);
/** A sealed profile as the parser takes it: base64url, no longer than a client writes. */
const isSealedProfile = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_SEALED_PROFILE_LENGTH && B64URL.test(v);
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
      if (!b64(m.publicKey) || !b64(m.hmac) || !b64(m.signature)) return invalid('unrecognised message');
      // A name in plain is from an app before ADR 0010: the server is not to learn it, and that app cannot seal one.
      if (m.profile === undefined && m.name !== undefined) return invalid(APP_OUT_OF_DATE);
      if (!isSealedProfile(m.profile)) return invalid('unrecognised message');
      if (m.authKey !== undefined && !(b64(m.authKey) && m.authKey.length === 43)) return invalid('unrecognised message');
      const auth: Extract<ClientMessage, { t: 'auth' }> = { t: 'auth', publicKey: m.publicKey, profile: m.profile, hmac: m.hmac, signature: m.signature };
      if (typeof m.authKey === 'string') auth.authKey = m.authKey;
      if (m.telemetry === true) auth.telemetry = true;
      // Optional: one of another shape is left out, so the friend still gets in, without private texts (ADR 0007).
      const k = m.privateTexts as Record<string, unknown> | null | undefined;
      if (k && typeof k === 'object' && isPublicKey(k.key) && b64(k.sig) && k.sig.length === 86) auth.privateTexts = { key: k.key, sig: k.sig };
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
    case 'profile':
      return isSealedProfile(m.profile) ? { t: 'profile', profile: m.profile } : invalid('unrecognised message');
    case 'name':
    case 'picture':
      return { ...invalid(APP_OUT_OF_DATE), ref: m.t }; // in plain: an app from before ADR 0010
    case 'ice':
      if (m.id !== undefined && !isRequestId(m.id)) return invalid('unrecognised message');
      return isRequestId(m.id) ? { t: 'ice', id: m.id } : { t: 'ice' };
    case 'share':
      if (typeof m.on !== 'boolean') return invalid('unrecognised message');
      if (m.viewers === undefined) return { t: 'share', on: m.on };
      if (!Array.isArray(m.viewers) || m.viewers.length > MAX_VIEWERS || !m.viewers.every(isPublicKey)) return invalid('unrecognised message');
      return { t: 'share', on: m.on, viewers: [...new Set(m.viewers)] };
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
      // A private text routed to one friend by key: an app from before ADR 0011, whose rooms of two carry them now.
      return { ...invalid(APP_OUT_OF_DATE), ref: 'private' };
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
    case 'piece':
      if (!isFileHash(m.hash) || !isPieceIndex(m.n) || typeof m.sealed !== 'string' || !B64URL.test(m.sealed) || m.sealed.length > MAX_SEALED_PIECE_LENGTH) return invalid('unrecognised message');
      return { t: 'piece', hash: m.hash, n: m.n, sealed: m.sealed };
    case 'fetch':
      return isFileHash(m.hash) && isPieceIndex(m.n) ? { t: 'fetch', hash: m.hash, n: m.n } : invalid('unrecognised message');
    case 'sync':
      return Number.isSafeInteger(m.since) && (m.since as number) >= 0 ? { t: 'sync', since: m.since as number } : invalid('unrecognised message');
    case 'text':
      return invalid(OUT_OF_DATE);
    default:
      return invalid('unrecognised message');
  }
}
