// Rooms (ADR 0004). A room is identified by nothing but its shared secret: the room id on the wire and
// the verifier the server stores are both derived from it. Anyone holding an invite link can find and,
// if need be, re-create the room; nobody else can so much as name it. WebCrypto only, no imports.
import { toBase64Url } from './identity';
import { normaliseName } from './protocol';

const SECRET_BYTES = 16;
/** base64url of a SHA-256 digest, unpadded. */
export const ROOM_ID_LENGTH = 43;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** Links from before rooms had names carry only the secret; that room gets this name. */
export const DEFAULT_ROOM_NAME = 'Friends';

/** A fresh secret for a room started in this browser: 128 random bits, base64url. */
export function newRoomSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

async function derive(label: string, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(`dave/${label}\n${secret}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/** The room's public name on the wire (the socket path). Knowing it gets nobody in. */
export const roomIdOf = (secret: string): Promise<string> => derive('room-id', secret);
/** What the client proves it holds and what the server keeps from the first visit on. Never the secret itself. */
export const authKeyOf = (secret: string): Promise<string> => derive('auth-key', secret);
export const isRoomId = (text: string): boolean => ROOM_ID_RE.test(text);

/** Room names follow the same rule as display names: 1 to 32 characters, whitespace collapsed. */
export const normaliseRoomName = normaliseName;

export type InviteLink = { secret: string; name: string };

const decode = (part: string): string => { try { return decodeURIComponent(part); } catch { return part; } };

/** The fragment of an invite link: `#<secret>/<name>`. A bare `#<secret>` is a link from before rooms had names. */
export function parseInviteFragment(hash: string): InviteLink | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const secret = decode(slash < 0 ? raw : raw.slice(0, slash));
  if (!secret) return null;
  const name = slash < 0 ? null : normaliseRoomName(decode(raw.slice(slash + 1)));
  return { secret, name: name ?? DEFAULT_ROOM_NAME };
}

export function formatInviteFragment(link: InviteLink): string {
  return `#${encodeURIComponent(link.secret)}/${encodeURIComponent(link.name)}`;
}

/**
 * An invite link as a friend pastes it: the whole URL, just its fragment, or the bare `secret/name`.
 * Everything from the first `#` counts. Without one, only a single token with no whitespace and no
 * `://` is taken as a fragment, so a URL without a fragment or a sentence off the clipboard is not a
 * link and cannot open a garbage room. Needed because iOS never routes a tapped link into a home-screen
 * web app, so pasting is the only way a room gets in there.
 */
export function parseInviteText(text: string): InviteLink | null {
  const trimmed = text.trim();
  const hash = trimmed.indexOf('#');
  if (hash >= 0) return parseInviteFragment(trimmed.slice(hash));
  if (/\s/.test(trimmed) || trimmed.includes('://')) return null;
  return parseInviteFragment(trimmed);
}
