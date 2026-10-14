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
  /**
   * `telemetry`: the browser opted in to PostHog (ticket 32). Kept here, never in `person`, so presence does not carry it.
   * `turnUsers`: every TURN user this friend's peer connections may still relay through, those of her earlier sockets
   * included (`takeOverTurn`); revoked when she leaves the call, and by nothing else. `joins`: how many times this
   * socket joined the call, so a TURN user minted for an earlier join is told from the call's (settleTurnUser).
   */
  | { stage: 'attached'; person: Person; bucket: Bucket; signalBucket?: Bucket; attachedAt: number; turnUsers?: string[]; joins?: number; telemetry?: true }
  /** Told to close (superseded, silent too long, errored) or closed, but still attached until the runtime finishes the handshake; invisible meanwhile. */
  | { stage: 'closing' };

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
  /** First correct answer in a room nobody had entered: the adapter keeps this as the room's verifier (ADR 0004). */
  storeAuthKey?: string;
  /**
   * Replies that need I/O (TURN minting). The adapter stores `state` first, then awaits this and
   * sends what it returns, so a second join arriving mid-fetch already sees the new join sequence.
   * A TURN user it minted goes where settleTurnUser says, by the socket's state by then.
   */
  after?: () => Promise<{ replies: ServerMessage[]; minted: MintedTurn }>;
  /** This friend joined the call: the adapter hands this socket the TURN users her earlier sockets left. Her public key. */
  takeOverTurn?: string;
  /** TURN credentials to revoke (participant left). */
  revokeTurn?: string[];
  close?: { code: number; reason: string };
  /**
   * An authenticated frame the server refused as malformed or oversized: a client bug or a limit worth knowing about,
   * so the adapter logs it where the sender's own analytics cannot lose it (ticket 30). Rate limited frames are not
   * listed; a flood would log a flood. The rate limit bounds these too, since every frame takes a token first.
   * `telemetry` is the sender's PostHog opt-in (ticket 32): without it the adapter logs, but sends nothing to PostHog.
   */
  rejected?: { from: string; reason: string; ref?: ClientMessage['t']; length: number; telemetry: boolean };
};

export type RoomContext = {
  /** The room's verifier, derived from the shared secret by the first visitor; null while nobody has entered yet. */
  authKey: string | null;
  /** Current time in ms; injected so tests can drive time. */
  now: number;
  /** Everyone else currently attached (this socket excluded). Join sequences derive from it. */
  others: Iterable<Person>;
  /** Mints ICE servers (TURN credentials) for a participant. Provided by the adapter. */
  mintIce: () => Promise<{ iceServers: IceServer[]; turnUser: string | null }>;
};

/** ICE servers minted for the socket's join number `forJoin` (SocketState `joins`); `turnUser` null when STUN only. */
export type MintedTurn = { turnUser: string | null; forJoin: number };

/**
 * TURN users kept per friend at most. Each join or ice refresh adds one, and a reconnect carries them over, so a long call
 * on flaky Wi-Fi could grow the list past the attachment's 16 KB; the oldest are let go unrevoked, to run out on their own.
 */
export const MAX_TURN_USERS = 16;

/**
 * Where minted ICE servers go once the mint is back. If the socket is still in the join they were minted for, its TURN user
 * goes onto the socket and the answer is sent. If it left that join meanwhile (a Leave, a Join again, closed, superseded,
 * swept, errored), the answer is not sent, since a client from before request ids would take it for its next join, and
 * the TURN user is revoked: nobody was given it, and nothing else would ever revoke it.
 */
export function settleTurnUser(current: SocketState | null, minted: MintedTurn): { state: SocketState } | { revoke: string | null } {
  if (current?.stage === 'attached' && current.person.role === 'participant' && (current.joins ?? 0) === minted.forJoin) {
    return { state: minted.turnUser ? { ...current, turnUsers: [...(current.turnUsers ?? []), minted.turnUser].slice(-MAX_TURN_USERS) } : current };
  }
  return { revoke: minted.turnUser };
}

/** A socket has just been accepted: challenge it. `fresh` tells the client the room has no verifier yet. */
export function openSocket(now: number, fresh = false): Outcome {
  const nonce = toBase64Url(randomNonce());
  return { state: { stage: 'challenge', nonce, attempts: 0, since: now }, replies: [fresh ? { t: 'challenge', nonce, fresh: true } : { t: 'challenge', nonce }] };
}

/** True when an unanswered challenge has outlived its window and the socket should be closed. */
export function challengeExpired(state: SocketState, now: number): boolean {
  return state.stage === 'challenge' && now - state.since >= CHALLENGE_TIMEOUT_MS;
}

/** Presence is nothing but the attached sockets' attachments. */
/**
 * One entry per identity, from its newest socket. A superseded or dead socket can stay attached until the
 * runtime finishes closing it, and every later broadcast used to list it again: two rows for one friend,
 * seen live on 2026-09-10 after a run of socket drops.
 */
export function presenceSnapshot(states: Iterable<SocketState | null | undefined>): Extract<ServerMessage, { t: 'presence' }> {
  const newest = new Map<string, Extract<SocketState, { stage: 'attached' }>>();
  for (const s of states) {
    if (!s || s.stage !== 'attached') continue;
    const seen = newest.get(s.person.publicKey);
    if (!seen || s.attachedAt >= seen.attachedAt) newest.set(s.person.publicKey, s);
  }
  return { t: 'presence', people: [...newest.values()].map((s) => s.person) };
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
    // A room nobody has entered takes its verifier from the first correct answer: whoever holds the secret
    // derives the same key, so a wiped server is re-created by the next friend who opens the link.
    const authKey = ctx.authKey ?? msg.authKey ?? null;
    if (!authKey) return strike(state, 'unknown room');
    const publicKeyRaw = fromBase64Url(msg.publicKey);
    const nonce = fromBase64Url(state.nonce);
    const hmac = fromBase64Url(msg.hmac);
    const signature = fromBase64Url(msg.signature);
    const ok = publicKeyRaw && nonce && hmac && signature && (await verifyAnswer({ authKey, nonce, publicKeyRaw, hmac, signature }));
    if (!ok) return strike(state, 'authentication failed');
    const person: Person = {
      publicKey: msg.publicKey,
      fingerprint: await fingerprint(publicKeyRaw),
      name: msg.name,
      ...(msg.picture ? { picture: msg.picture } : {}),
      role: 'visitor',
      joinSeq: null,
      sharing: false,
      muted: false,
    };
    // A newer socket for a known identity wins: an older one is either a ghost the server has not
    // noticed dying (the client already reconnected) or another tab, which is told so.
    return {
      state: { stage: 'attached', person, bucket: newBucket(ctx.now), attachedAt: ctx.now, ...(msg.telemetry ? { telemetry: true as const } : {}) },
      replies: [{ t: 'welcome', you: person }],
      presenceChanged: true,
      supersede: msg.publicKey,
      ...(ctx.authKey === null ? { storeAuthKey: authKey } : {}),
    };
  }

  if (state.stage === 'closing') return { state, replies: [] }; // already told to go; nothing it says counts

  if (state.stage !== 'attached') {
    // Unknown state shape (for example after a protocol change): fail closed.
    return { state, replies: [{ t: 'error', reason: 'invalid socket state' }], close: { code: CLOSE_AUTH_FAILED, reason: 'invalid socket state' } };
  }

  const error = (reason: string, ref: ClientMessage['t'] | undefined): ServerMessage => (ref ? { t: 'error', reason, ref } : { t: 'error', reason });

  // Rate limit every authenticated frame, parseable or not. Signaling has its own generous bucket (see ratelimit.ts).
  let next: SocketState;
  if (msg.t === 'signal') {
    const taken = takeToken(state.signalBucket ?? newBucket(ctx.now, SIGNAL_BURST), ctx.now, SIGNAL_RATE_PER_SECOND, SIGNAL_BURST);
    next = { ...state, signalBucket: taken.bucket };
    if (!taken.ok) return { state: next, replies: [error('rate limited', 'signal')] };
  } else {
    const taken = takeToken(state.bucket, ctx.now);
    next = { ...state, bucket: taken.bucket };
    const ref = msg.t === 'invalid' ? msg.ref : msg.t;
    if (!taken.ok) return { state: next, replies: [error('rate limited', ref)] };
  }
  const notInCall = (ref: ClientMessage['t']): Outcome => ({ state: next, replies: [{ t: 'error', reason: 'not in the call', ref }] });
  // Any participant entry for the key counts, whatever else is listed under it.
  const participantByKey = (key: string): Person | undefined => { for (const p of ctx.others) if (p.publicKey === key && p.role === 'participant') return p; return undefined; };

  switch (msg.t) {
    case 'invalid':
      return {
        state: next,
        replies: [error(msg.reason, msg.ref)],
        rejected: { from: state.person.publicKey, reason: msg.reason, ...(msg.ref ? { ref: msg.ref } : {}), length: typeof raw === 'string' ? raw.length : raw instanceof ArrayBuffer ? raw.byteLength : 0, telemetry: state.telemetry === true },
      };
    case 'auth':
      return { state: next, replies: [{ t: 'error', reason: 'already authenticated', ref: 'auth' }] };
    case 'ping':
      // Normally answered by the hibernation auto-response before reaching here.
      return { state: next, replies: [{ t: 'pong' }] };
    case 'text': {
      const { publicKey, fingerprint: fp, name, picture } = state.person;
      return { state: next, replies: [], broadcast: [{ t: 'text', from: { publicKey, fingerprint: fp, name, ...(picture ? { picture } : {}) }, text: msg.text, at: ctx.now, ...(msg.id !== undefined ? { id: msg.id } : {}) }] };
    }
    case 'join': {
      // Joining twice (after a server reconnect) is fine: a fresh join sequence, same identity.
      // The sequence is fixed and stored before the TURN fetch so concurrent joins cannot collide.
      const joinSeq = nextJoinSeq([...ctx.others, state.person]);
      const person: Person = { ...state.person, role: 'participant', joinSeq, muted: msg.muted, sharing: msg.sharing === true };
      const joins = (state.joins ?? 0) + 1;
      const now = ctx.now;
      const id = msg.id !== undefined ? { id: msg.id } : {}; // a client from before request ids sends none (protocol.ts, RequestId)
      return {
        state: { ...next, person, joins },
        replies: [],
        presenceChanged: true,
        takeOverTurn: person.publicKey,
        after: async () => {
          const { iceServers, turnUser } = await ctx.mintIce();
          return { replies: [{ t: 'call', joinSeq, iceServers, issuedAt: now, ...id }], minted: { turnUser, forJoin: joins } };
        },
      };
    }
    case 'leave': {
      if (state.person.role !== 'participant') return { state: next, replies: [] };
      const person: Person = { ...state.person, role: 'visitor', joinSeq: null, sharing: false, muted: false };
      const { turnUsers, ...rest } = next;
      return { state: { ...rest, person }, replies: [], broadcast: [{ t: 'left', publicKey: person.publicKey }], presenceChanged: true, ...(turnUsers?.length ? { revokeTurn: turnUsers } : {}) };
    }
    case 'mute': {
      if (state.person.role !== 'participant' || state.person.muted === msg.muted) return { state: next, replies: [] };
      return { state: { ...next, person: { ...state.person, muted: msg.muted } }, replies: [], presenceChanged: true };
    }
    case 'name': {
      if (state.person.name === msg.name) return { state: next, replies: [] };
      return { state: { ...next, person: { ...state.person, name: msg.name } }, replies: [], presenceChanged: true };
    }
    case 'picture': {
      if ((state.person.picture ?? null) === msg.picture) return { state: next, replies: [] };
      const { picture: _old, ...person } = state.person;
      return { state: { ...next, person: msg.picture ? { ...person, picture: msg.picture } : person }, replies: [], presenceChanged: true };
    }
    case 'telemetry': {
      const { telemetry: _was, ...rest } = next;
      return { state: msg.on ? { ...rest, telemetry: true } : rest, replies: [] };
    }
    case 'ice': {
      if (state.person.role !== 'participant') return notInCall('ice');
      const now = ctx.now;
      const id = msg.id !== undefined ? { id: msg.id } : {};
      const forJoin = state.joins ?? 0;
      return { state: next, replies: [], after: async () => { const { iceServers, turnUser } = await ctx.mintIce(); return { replies: [{ t: 'ice', iceServers, issuedAt: now, ...id }], minted: { turnUser, forJoin } }; } };
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
