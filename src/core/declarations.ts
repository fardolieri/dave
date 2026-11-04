// What a client declares to its Room (quality ticket 10): its name and picture, its PostHog opt-in, and in the call whether
// it is muted, whether it shares, and whose share it watches. Unlike an event (a text, a signal, a join), only the latest
// value of each counts, and the Room forgets them all with the socket. client/room.ts keeps the latest here and declares
// them again on every socket the Room lets in, so no caller has to. Runtime-neutral: plain data only.
import type { ClientMessage, PresenceState } from './protocol';

/**
 * My name and picture, as one declaration: they go out together, sealed for the room (ADR 0010, client/room.ts), as
 * `{ t: 'profile', profile }`. Every other kind goes out as it is.
 */
export type ProfileDeclaration = { t: 'profile'; name: string; picture: string | null };
export type Declaration = ProfileDeclaration | Extract<ClientMessage, { t: 'telemetry' | 'mute' | 'share' | 'subscribe' }>;

/** The latest declaration of each kind, one subscribe per sharer, by `keyOf`. */
export type Declared = Map<string, Declaration>;
const keyOf = (d: Declaration): string => (d.t === 'subscribe' ? `subscribe:${d.to}` : d.t);

/** The Room takes these only from a friend in its call: before her join on a socket it drops or refuses them. */
export const inCallOnly = (d: Declaration): boolean => d.t === 'mute' || d.t === 'share' || d.t === 'subscribe';

/** What an auth says of the friend: her name, picture and opt-in as declared last. */
export type Carried = { name: string; picture: string | null; telemetry: boolean };

export function declared(name: string, picture: string | null, telemetry: boolean): Declared {
  const d: Declared = new Map();
  declare(d, { t: 'profile', name, picture });
  declare(d, { t: 'telemetry', on: telemetry });
  return d;
}

export function declare(d: Declared, m: Declaration): void { d.set(keyOf(m), m); }

const get = <T extends Declaration['t']>(d: Declared, t: T) => d.get(t) as Extract<Declaration, { t: T }> | undefined;

export function carried(d: Declared): Carried {
  const { name, picture } = get(d, 'profile')!;
  return { name, picture, telemetry: get(d, 'telemetry')!.on };
}

/** After the welcome: what changed since the auth on that socket went out (during the handshake, nothing could be sent). */
export function afterWelcome(d: Declared, auth: Carried): Declaration[] {
  const now = carried(d);
  const out: Declaration[] = [];
  if (now.name !== auth.name || now.picture !== auth.picture) out.push(get(d, 'profile')!);
  if (now.telemetry !== auth.telemetry) out.push(get(d, 'telemetry')!);
  return out;
}

/** What a join declares: muted and sharing as declared last; unmuted and not sharing before either was. */
export function joinDeclares(d: Declared): { muted: boolean; sharing: boolean } {
  return { muted: get(d, 'mute')?.muted ?? false, sharing: get(d, 'share')?.on ?? false };
}

/**
 * After the join on a socket is answered: every ask to watch or stop watching, to friends presence lists as sharing in
 * the call. A sharer keeps who watches her in her browser, across this friend's reconnects, so a repeated ask changes
 * nothing there; one lost with the last socket is made up for. Mute and share ride in the join itself, but not who
 * watches the share: a new socket starts without them, so a share with viewers is declared again.
 */
export function afterJoin(d: Declared, people: readonly (PresenceState & { publicKey: string })[]): Declaration[] {
  const sharing = new Set(people.filter((p) => p.role === 'participant' && p.sharing).map((p) => p.publicKey));
  const share = get(d, 'share');
  return [...(share?.on && share.viewers?.length ? [share] : []), ...[...d.values()].filter((m) => m.t === 'subscribe' && sharing.has(m.to))];
}

/**
 * Presence lists a friend in the call as not sharing: an ask to watch her ended with her share, and a later share of hers
 * starts unwatched, as client/call.ts does with its intent (reconcile). A friend listed as a visitor or not at all may only
 * be reconnecting, and is kept; one who left on purpose is forgotten by `forgetWatch`.
 */
export function forgetEnded(d: Declared, people: readonly (PresenceState & { publicKey: string })[]): void {
  for (const p of people) if (p.role === 'participant' && !p.sharing) forgetWatch(d, p.publicKey);
}

export function forgetWatch(d: Declared, publicKey: string): void { d.delete(`subscribe:${publicKey}`); }

/** The call ended for this friend: what she declared in it ends with it. */
export function leaveCall(d: Declared): void {
  for (const [k, m] of d) if (inCallOnly(m)) d.delete(k);
}
