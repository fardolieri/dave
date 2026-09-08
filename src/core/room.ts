// Per-socket state machine, runtime-neutral. The Durable Object adapter stores the
// returned state in the socket attachment, sends the replies, and closes when told.
// Everything here is plain data plus WebCrypto, so it survives hibernation.
// No Cloudflare, Node, or DOM imports; scripts/check-core-isolation.mjs enforces that.
import { fromBase64Url, fingerprint, randomNonce, toBase64Url, verifyAnswer } from './identity';
import { CLOSE_AUTH_FAILED, parseClientMessage, type ClientMessage, type IceServer, type Person, type ServerMessage } from './protocol';
import { SIGNAL_BURST, SIGNAL_RATE_PER_SECOND, newBucket, takeToken, type Bucket } from './ratelimit';
import { nextJoinSeq } from './mesh';

export const MAX_AUTH_ATTEMPTS = 3;
/** A socket that has not answered its challenge within this window is closed by the sweep. */
export const CHALLENGE_TIMEOUT_MS = 10_000;

export type SocketState =
  | { stage: 'challenge'; nonce: string; attempts: number; since: number }
  | { stage: 'attached'; person: Person; bucket: Bucket; signalBucket?: Bucket; attachedAt: number; turnUser?: string };

export type Outcome = {
  state: SocketState;
  /** Sent to this socket only. */
  replies: ServerMessage[];
  /** Sent to every attached socket, this one included. */
  broadcast?: ServerMessage[];
  /** The set or shape of attached people changed; the adapter must broadcast a fresh snapshot. */
  presenceChanged?: boolean;
  /** Deliver to the one attached participant with this public key. */
  relay?: { to: string; message: ServerMessage };
  /** Close every other socket attached under this public key: one live socket per identity (spec §4). */
  supersede?: string;
  /**
   * Replies that need I/O (TURN minting). The adapter stores `state` first, then awaits this and
   * sends what it returns, so a second join arriving mid-fetch already sees the new join sequence.
   * The returned state patch is merged into the attachment afterwards.
   */
  after?: () => Promise<{ replies: ServerMessage[]; patch?: Partial<Extract<SocketState, { stage: 'attached' }>> }>;
  /** A TURN credential to revoke (participant left). */
  revokeTurn?: string;
  close?: { code: number; reason: string };
};

export type RoomContext = {
  /** The shared secret, held only by the server. */
  secret: string;
  /** Current time in ms; injected so tests can drive time. */
  now: number;
  /** Everyone else currently attached (this socket excluded). Join sequences derive from it. */
  others: Iterable<Person>;
  /** Mints ICE servers (TURN credentials) for a participant. Provided by the adapter. */
  mintIce: () => Promise<{ iceServers: IceServer[]; turnUser: string | null }>;
};

/** A socket has just been accepted: challenge it. */
export function openSocket(now: number): Outcome {
  const nonce = toBase64Url(randomNonce());
  return { state: { stage: 'challenge', nonce, attempts: 0, since: now }, replies: [{ t: 'challenge', nonce }] };
}

/** True when an unanswered challenge has outlived its window and the socket should be closed. */
export function challengeExpired(state: SocketState, now: number): boolean {
  return state.stage === 'challenge' && now - state.since >= CHALLENGE_TIMEOUT_MS;
}

/** Presence is nothing but the attached sockets' attachments. */
export function presenceSnapshot(states: Iterable<SocketState | null | undefined>): Extract<ServerMessage, { t: 'presence' }> {
  const people: Person[] = [];
  for (const s of states) if (s && s.stage === 'attached') people.push(s.person);
  return { t: 'presence', people };
}

/** Every frame before authentication that is not a correct answer counts as a strike. */
function strike(state: Extract<SocketState, { stage: 'challenge' }>, reason: string): Outcome {
  const attempts = state.attempts + 1;
  const failed: SocketState = { ...state, attempts };
  const replies: ServerMessage[] = [{ t: 'error', reason }];
  if (attempts >= MAX_AUTH_ATTEMPTS) return { state: failed, replies, close: { code: CLOSE_AUTH_FAILED, reason: 'authentication failed' } };
  return { state: failed, replies };
}

export async function onMessage(state: SocketState, raw: unknown, ctx: RoomContext): Promise<Outcome> {
  const msg = parseClientMessage(raw);

  if (state.stage === 'challenge') {
    if (msg.t === 'invalid') return strike(state, msg.reason);
    if (msg.t !== 'auth') return strike(state, 'unauthenticated');
    const publicKeyRaw = fromBase64Url(msg.publicKey);
    const nonce = fromBase64Url(state.nonce);
    const hmac = fromBase64Url(msg.hmac);
    const signature = fromBase64Url(msg.signature);
    const ok = publicKeyRaw && nonce && hmac && signature && (await verifyAnswer({ secret: ctx.secret, nonce, publicKeyRaw, hmac, signature }));
    if (!ok) return strike(state, 'authentication failed');
    const person: Person = {
      publicKey: msg.publicKey,
      fingerprint: await fingerprint(publicKeyRaw),
      name: msg.name,
      role: 'visitor',
      joinSeq: null,
      sharing: false,
      muted: false,
    };
    // A newer socket for a known identity wins: an older one is either a ghost the server has not
    // noticed dying (the client already reconnected) or another tab, which is told so.
    return { state: { stage: 'attached', person, bucket: newBucket(ctx.now), attachedAt: ctx.now }, replies: [{ t: 'welcome', you: person }], presenceChanged: true, supersede: msg.publicKey };
  }

  if (state.stage !== 'attached') {
    // Unknown state shape (for example after a protocol change): fail closed.
    return { state, replies: [{ t: 'error', reason: 'invalid socket state' }], close: { code: CLOSE_AUTH_FAILED, reason: 'invalid socket state' } };
  }

  // Rate limit every authenticated frame, parseable or not. Signaling has its own generous bucket (see ratelimit.ts).
  let next: SocketState;
  if (msg.t === 'signal') {
    const taken = takeToken(state.signalBucket ?? newBucket(ctx.now, SIGNAL_BURST), ctx.now, SIGNAL_RATE_PER_SECOND, SIGNAL_BURST);
    next = { ...state, signalBucket: taken.bucket };
    if (!taken.ok) return { state: next, replies: [{ t: 'error', reason: 'rate limited', ref: 'signal' }] };
  } else {
    const taken = takeToken(state.bucket, ctx.now);
    next = { ...state, bucket: taken.bucket };
    if (!taken.ok) return { state: next, replies: [{ t: 'error', reason: 'rate limited', ref: msg.t === 'invalid' ? undefined : msg.t }] };
  }
  const notInCall = (ref: ClientMessage['t']): Outcome => ({ state: next, replies: [{ t: 'error', reason: 'not in the call', ref }] });
  // Any participant entry for the key counts, whatever else is listed under it.
  const participantByKey = (key: string): Person | undefined => { for (const p of ctx.others) if (p.publicKey === key && p.role === 'participant') return p; return undefined; };

  switch (msg.t) {
    case 'invalid':
      return { state: next, replies: [{ t: 'error', reason: msg.reason }] };
    case 'auth':
      return { state: next, replies: [{ t: 'error', reason: 'already authenticated', ref: 'auth' }] };
    case 'ping':
      // Normally answered by the hibernation auto-response before reaching here.
      return { state: next, replies: [{ t: 'pong' }] };
    case 'text': {
      const { publicKey, fingerprint: fp, name } = state.person;
      return { state: next, replies: [], broadcast: [{ t: 'text', from: { publicKey, fingerprint: fp, name }, text: msg.text, at: ctx.now }] };
    }
    case 'join': {
      // Joining twice (after a server reconnect) is fine: a fresh join sequence, same identity.
      // The sequence is fixed and stored before the TURN fetch so concurrent joins cannot collide.
      const joinSeq = nextJoinSeq([...ctx.others, state.person]);
      const person: Person = { ...state.person, role: 'participant', joinSeq, muted: msg.muted, sharing: msg.sharing === true };
      const now = ctx.now;
      return {
        state: { ...next, person },
        replies: [],
        presenceChanged: true,
        after: async () => {
          const { iceServers, turnUser } = await ctx.mintIce();
          return { replies: [{ t: 'call', joinSeq, iceServers, issuedAt: now }], patch: turnUser ? { turnUser } : {} };
        },
      };
    }
    case 'leave': {
      if (state.person.role !== 'participant') return { state: next, replies: [] };
      const person: Person = { ...state.person, role: 'visitor', joinSeq: null, sharing: false, muted: false };
      const { turnUser, ...rest } = next;
      return { state: { ...rest, person }, replies: [], broadcast: [{ t: 'left', publicKey: person.publicKey }], presenceChanged: true, revokeTurn: turnUser };
    }
    case 'mute': {
      if (state.person.role !== 'participant' || state.person.muted === msg.muted) return { state: next, replies: [] };
      return { state: { ...next, person: { ...state.person, muted: msg.muted } }, replies: [], presenceChanged: true };
    }
    case 'ice': {
      if (state.person.role !== 'participant') return notInCall('ice');
      const now = ctx.now;
      return { state: next, replies: [], after: async () => { const { iceServers, turnUser } = await ctx.mintIce(); return { replies: [{ t: 'ice', iceServers, issuedAt: now }], patch: turnUser ? { turnUser } : {} }; } };
    }
    case 'share': {
      if (state.person.role !== 'participant') return notInCall('share');
      if (state.person.sharing === msg.on) return { state: next, replies: [] };
      return { state: { ...next, person: { ...state.person, sharing: msg.on } }, replies: [], presenceChanged: true };
    }
    case 'subscribe': {
      if (state.person.role !== 'participant') return notInCall('subscribe');
      if (!participantByKey(msg.to)) return { state: next, replies: [{ t: 'error', reason: 'that participant is not in the call', ref: 'subscribe' }] };
      return { state: next, replies: [], relay: { to: msg.to, message: { t: 'subscribe', from: state.person.publicKey, on: msg.on, ...(msg.scale ? { scale: msg.scale } : {}) } } };
    }
    case 'signal': {
      if (state.person.role !== 'participant') return notInCall('signal');
      if (!participantByKey(msg.to)) return { state: next, replies: [{ t: 'error', reason: 'that participant is not in the call', ref: 'signal' }] };
      return { state: next, replies: [], relay: { to: msg.to, message: { t: 'signal', from: state.person.publicKey, data: msg.data } } };
    }
  }
}
