// Per-socket state machine, runtime-neutral. The Durable Object adapter stores the
// returned state in the socket attachment, sends the replies, and closes when told.
// Everything here is plain data plus WebCrypto, so it survives hibernation.
// No Cloudflare, Node, or DOM imports; scripts/check-core-isolation.mjs enforces that.
import { fromBase64Url, fingerprint, randomNonce, toBase64Url, verifyAnswer } from './identity';
import { APP_OUT_OF_DATE, CLOSE_AUTH_FAILED, CLOSE_OUT_OF_DATE, OUT_OF_DATE, parseClientMessage, wireIdentityOf, type ClientMessage, type IceServer, type KeptEntry, type RefType, type ServerMessage, type TextId, type WirePerson as Person } from './protocol';
import { SIGNAL_BURST, SIGNAL_RATE_PER_SECOND, newBucket, takeToken, type Bucket } from './ratelimit';
import { LINK_ICE_TTL_SECONDS, nextJoinSeq } from './mesh';
import { SYNC_COOLDOWN_MS, SYNC_MAX, historyFrames, pieceId } from './kept';

export const MAX_AUTH_ATTEMPTS = 3;
/**
 * Pieces of a file a socket sends up a second (ADR 0009), and asks back: 2 MB up, 4 MB down, a burst of twice that. The
 * client paces its uploads under it (client/room.ts).
 */
export const PIECE_RATE_PER_SECOND = 8;
export const FETCH_RATE_PER_SECOND = 16;
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
  | { stage: 'attached'; person: Person; bucket: Bucket; signalBucket?: Bucket; linkBucket?: Bucket; linkIceAt?: number; syncAt?: number; forgetAt?: number; pieceBucket?: Bucket; fetchBucket?: Bucket; attachedAt: number; turnUsers?: string[]; joins?: number; telemetry?: true }
  /**
   * Told to close (superseded, silent too long, errored) or closed, but still attached until the runtime finishes the handshake; invisible meanwhile.
   * `attachedAt` as it was when attached, for the log of its close (worker/room.ts); none in sockets from before it was kept.
   */
  | { stage: 'closing'; attachedAt?: number };

export type Outcome = {
  state: SocketState;
  /** Sent to this socket only. */
  replies: ServerMessage[];
  /** Sent to every attached socket, this one included. */
  broadcast?: ServerMessage[];
  /** The set or shape of attached people changed; the adapter must broadcast a fresh snapshot. */
  presenceChanged?: boolean;
  /** Deliver to the one attached friend with this public key. */
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
  after?: () => Promise<{ replies: ServerMessage[]; minted: MintedTurn | null }>;
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
  rejected?: { from: string; reason: string; ref?: RefType; length: number; telemetry: boolean };
  /** A text or file announcement went out to the room: the adapter hands it to the server's history (ADR 0009). */
  keep?: KeptEntry;
};

export type RoomContext = {
  /** The room's verifier, derived from the shared secret by the first visitor; null while nobody has entered yet. */
  authKey: string | null;
  /** Current time in ms; injected so tests can drive time. */
  now: number;
  /** Everyone else currently attached (this socket excluded). Join sequences derive from it. */
  others: Iterable<Person>;
  /** Mints ICE servers (TURN credentials) for a participant, or for a file link with a shorter life. Provided by the adapter. */
  mintIce: (ttlSeconds?: number) => Promise<{ iceServers: IceServer[]; turnUser: string | null }>;
  /**
   * The room's kept entries the server took after `since`, the newest `max` of them, oldest first (ADR 0009); null when it
   * could not say. Provided by the adapter; none where nothing is kept (core tests), which answers every sync with none.
   */
  history?: (since: number, max: number) => Promise<KeptEntry[] | null>;
  /** A piece of a kept file by its id, sealed (base64url), whoever sent it up; null when it is not kept, or the server cannot say. */
  piece?: (id: string) => Promise<string | null>;
  /**
   * Keeps a piece of a file sent up, by its id, under its sender (`writer`) and the Room's clock (`at`), as a `forget`
   * asks by: 'kept', 'not today' (the daily share used up), or 'failed' (try again).
   */
  keepPiece?: (writer: string, id: string, sealed: string, at: number) => Promise<'kept' | 'not today' | 'failed'>;
  /**
   * Deletes what `writer` wrote in this room up to `before` (the Room's clock) from the server's history: true when all
   * of it is gone, false when the daily share of writes ran out first or it failed.
   */
  forget?: (writer: string, before: number) => Promise<boolean>;
};

/** ICE servers minted for the socket's join number `forJoin` (SocketState `joins`); `turnUser` null when STUN only. */
export type MintedTurn = { turnUser: string | null; forJoin: number };

/**
 * TURN users kept per friend at most. Each join or ice refresh adds one, and a reconnect carries them over, so a long call
 * on flaky Wi-Fi could grow the list past the attachment's 16 KB; the oldest are let go unrevoked, to run out on their own.
 */
export const MAX_TURN_USERS = 16;
/** A socket asks for a file link's ICE servers once a minute at most (`linkice`). */
export const LINK_ICE_COOLDOWN_MS = 60_000;

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

/** The person with these viewers of the share; none, or an empty list, leaves the field out. */
function withViewers(person: Person, viewers: string[] | undefined): Person {
  const { viewers: _old, ...rest } = person;
  return viewers?.length ? { ...rest, viewers } : rest;
}
const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

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
    // An app from before ADR 0010, its name in plain: closed for it to try again, quietly, once it is reloaded (protocol.ts).
    if (msg.t === 'invalid' && msg.reason === APP_OUT_OF_DATE) return { state, replies: [], close: { code: CLOSE_OUT_OF_DATE, reason: 'app out of date' } };
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
      profile: msg.profile, // sealed (ADR 0010): the name and picture are the friends' to read
      role: 'visitor',
      joinSeq: null,
      sharing: false,
      muted: false,
      ...(msg.privateTexts ? { privateTexts: msg.privateTexts } : {}),
    };
    // A newer socket for a known identity wins: an older one is either a ghost the server has not
    // noticed dying (the client already reconnected) or another tab, which is told so.
    return {
      state: { stage: 'attached', person, bucket: newBucket(ctx.now), attachedAt: ctx.now, ...(msg.telemetry ? { telemetry: true as const } : {}) },
      replies: [{ t: 'welcome', you: person, at: ctx.now }],
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

  const error = (reason: string, ref: RefType | undefined, id?: TextId): ServerMessage => ({ t: 'error', reason, ...(ref ? { ref } : {}), ...(id !== undefined ? { id } : {}) });

  // Rate limit every authenticated frame, parseable or not. Signaling has its own generous bucket (see ratelimit.ts), and
  // file links another as generous, so pulls cannot hold up the call's own signaling.
  let next: SocketState;
  if (msg.t === 'signal') {
    const taken = takeToken(state.signalBucket ?? newBucket(ctx.now, SIGNAL_BURST), ctx.now, SIGNAL_RATE_PER_SECOND, SIGNAL_BURST);
    next = { ...state, signalBucket: taken.bucket };
    if (!taken.ok) return { state: next, replies: [error('rate limited', 'signal')] };
  } else if (msg.t === 'piece' || msg.t === 'fetch') {
    // A file's pieces go up and come back in their own buckets: an upload of a file's pieces holds up no text, nor a download.
    const key = msg.t === 'piece' ? 'pieceBucket' : 'fetchBucket';
    const rate = msg.t === 'piece' ? PIECE_RATE_PER_SECOND : FETCH_RATE_PER_SECOND;
    const taken = takeToken(state[key] ?? newBucket(ctx.now, rate * 2), ctx.now, rate, rate * 2);
    next = { ...state, [key]: taken.bucket };
    if (!taken.ok) return { state: next, replies: [error('rate limited', msg.t)] };
  } else if (msg.t === 'link') {
    const taken = takeToken(state.linkBucket ?? newBucket(ctx.now, SIGNAL_BURST), ctx.now, SIGNAL_RATE_PER_SECOND, SIGNAL_BURST);
    next = { ...state, linkBucket: taken.bucket };
    if (!taken.ok) return { state: next, replies: [error('rate limited', 'link')] };
  } else {
    const taken = takeToken(state.bucket, ctx.now);
    next = { ...state, bucket: taken.bucket };
    const ref = msg.t === 'invalid' ? msg.ref : msg.t;
    if (!taken.ok) return { state: next, replies: [error('rate limited', ref)] };
  }
  const notInCall = (ref: ClientMessage['t']): Outcome => ({ state: next, replies: [{ t: 'error', reason: 'not in the call', ref }] });
  const attachedByKey = (key: string): boolean => { for (const p of ctx.others) if (p.publicKey === key) return true; return false; };
  // Any participant entry for the key counts, whatever else is listed under it.
  const participantByKey = (key: string): Person | undefined => { for (const p of ctx.others) if (p.publicKey === key && p.role === 'participant') return p; return undefined; };

  switch (msg.t) {
    case 'invalid':
      return {
        state: next,
        replies: [error(msg.reason, msg.ref, msg.id)],
        rejected: { from: state.person.publicKey, reason: msg.reason, ...(msg.ref ? { ref: msg.ref } : {}), length: typeof raw === 'string' ? raw.length : raw instanceof ArrayBuffer ? raw.byteLength : 0, telemetry: state.telemetry === true },
      };
    case 'auth':
      return { state: next, replies: [{ t: 'error', reason: 'already authenticated', ref: 'auth' }] };
    case 'ping':
      // Normally answered by the hibernation auto-response before reaching here.
      return { state: next, replies: [{ t: 'pong' }] };
    case 'sealed':
    case 'file': {
      const m: KeptEntry = { t: msg.t, from: wireIdentityOf(state.person), sealed: msg.sealed, at: ctx.now, id: msg.id };
      return { state: next, replies: [], broadcast: [m], keep: m };
    }
    case 'piece': {
      const { tag, n, sealed } = msg;
      const keep = ctx.keepPiece;
      const writer = state.person.publicKey;
      const at = ctx.now;
      return { state: next, replies: [], after: async () => {
        const kept = keep ? await keep(writer, pieceId(tag, n), sealed, at) : 'not today';
        return { replies: [{ t: 'kept', tag, n, ok: kept === 'kept', ...(kept === 'failed' ? { again: true as const } : {}) }], minted: null };
      } };
    }
    case 'fetch': {
      const { tag, n } = msg;
      const piece = ctx.piece;
      return { state: next, replies: [], after: async () => {
        const sealed = piece ? await piece(pieceId(tag, n)) : null;
        return { replies: [{ t: 'piece', tag, n, ...(sealed ? { sealed } : {}) }], minted: null };
      } };
    }
    case 'forget': {
      // One per welcome is all a client asks, and again only after a share ran out: more often is a loop.
      if (state.forgetAt !== undefined && ctx.now - state.forgetAt < SYNC_COOLDOWN_MS) return { state: next, replies: [error('asked too soon', 'forget')] };
      const before = msg.before ?? ctx.now;
      const forget = ctx.forget;
      const writer = state.person.publicKey;
      return { state: { ...next, forgetAt: ctx.now }, replies: [], after: async () => ({ replies: [{ t: 'forgot', before, done: forget ? await forget(writer, before) : true }], minted: null }) };
    }
    case 'sync': {
      // One per welcome is all a client asks; more often is a loop, or a friend reading the free plan's rows away.
      if (state.syncAt !== undefined && ctx.now - state.syncAt < SYNC_COOLDOWN_MS) return { state: next, replies: [error('asked too soon', 'sync')] };
      const { since } = msg;
      const history = ctx.history;
      const now = ctx.now;
      return { state: { ...next, syncAt: now }, replies: [], after: async () => ({ replies: historyFrames(history ? await history(since, SYNC_MAX) : [], now), minted: null }) };
    }
    case 'text':
      return { state: next, replies: [error(OUT_OF_DATE, 'text')] }; // the parser refuses it already
    case 'link': {
      // Visitors too: a file link is not part of the call (ADR 0006).
      if (msg.to === state.person.publicKey || !attachedByKey(msg.to)) return { state: next, replies: [{ t: 'error', reason: 'that friend is not here', ref: 'link' }] };
      return { state: next, replies: [], relay: { to: msg.to, message: { t: 'link', from: state.person.publicKey, data: msg.data } } };
    }
    case 'linkice': {
      // A client keeps them for most of their hour; asking again within a minute is a loop or a flood of TURN users.
      if (state.linkIceAt !== undefined && ctx.now - state.linkIceAt < LINK_ICE_COOLDOWN_MS) return { state: next, replies: [error('asked too soon', 'linkice')] };
      const now = ctx.now;
      const id = msg.id;
      return { state: { ...next, linkIceAt: now }, replies: [], after: async () => { const { iceServers } = await ctx.mintIce(LINK_ICE_TTL_SECONDS); return { replies: [{ t: 'linkice', iceServers, issuedAt: now, id }], minted: null }; } };
    }
    case 'join': {
      // Joining twice (after a server reconnect) is fine: a fresh join sequence, same identity.
      // The sequence is fixed and stored before the TURN fetch so concurrent joins cannot collide.
      const joinSeq = nextJoinSeq([...ctx.others, state.person]);
      const person: Person = withViewers({ ...state.person, role: 'participant', joinSeq, muted: msg.muted, sharing: msg.sharing === true }, msg.sharing === true ? state.person.viewers : undefined);
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
      const person: Person = withViewers({ ...state.person, role: 'visitor', joinSeq: null, sharing: false, muted: false }, undefined);
      const { turnUsers, ...rest } = next;
      return { state: { ...rest, person }, replies: [], broadcast: [{ t: 'left', publicKey: person.publicKey }], presenceChanged: true, ...(turnUsers?.length ? { revokeTurn: turnUsers } : {}) };
    }
    case 'mute': {
      if (state.person.role !== 'participant' || state.person.muted === msg.muted) return { state: next, replies: [] };
      return { state: { ...next, person: { ...state.person, muted: msg.muted } }, replies: [], presenceChanged: true };
    }
    case 'profile': {
      if (state.person.profile === msg.profile) return { state: next, replies: [] };
      return { state: { ...next, person: { ...state.person, profile: msg.profile } }, replies: [], presenceChanged: true };
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
      const viewers = msg.on ? msg.viewers ?? state.person.viewers : undefined;
      if (state.person.sharing === msg.on && sameKeys(state.person.viewers ?? [], viewers ?? [])) return { state: next, replies: [] };
      return { state: { ...next, person: withViewers({ ...state.person, sharing: msg.on }, viewers) }, replies: [], presenceChanged: true };
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
