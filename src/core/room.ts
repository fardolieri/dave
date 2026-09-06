// Per-socket state machine, runtime-neutral. The Durable Object adapter stores the
// returned state in the socket attachment, sends the replies, and closes when told.
// Everything here is plain data plus WebCrypto, so it survives hibernation.
// No Cloudflare, Node, or DOM imports; scripts/check-core-isolation.mjs enforces that.
import { fromBase64Url, fingerprint, randomNonce, toBase64Url, verifyAnswer } from './identity';
import { CLOSE_AUTH_FAILED, parseClientMessage, type Person, type ServerMessage } from './protocol';
import { newBucket, takeToken, type Bucket } from './ratelimit';

export const MAX_AUTH_ATTEMPTS = 3;
/** A socket that has not answered its challenge within this window is closed by the sweep. */
export const CHALLENGE_TIMEOUT_MS = 10_000;

export type SocketState =
  | { stage: 'challenge'; nonce: string; attempts: number; since: number }
  | { stage: 'attached'; person: Person; bucket: Bucket };

export type Outcome = {
  state: SocketState;
  /** Sent to this socket only. */
  replies: ServerMessage[];
  /** Sent to every attached socket, this one included. */
  broadcast?: ServerMessage[];
  /** The set or shape of attached people changed; the adapter must broadcast a fresh snapshot. */
  presenceChanged?: boolean;
  close?: { code: number; reason: string };
};

export type RoomContext = {
  /** The shared secret, held only by the server. */
  secret: string;
  /** Current time in ms; injected so tests can drive time. */
  now: number;
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
    if (!msg) return strike(state, 'unrecognised message');
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
    return { state: { stage: 'attached', person, bucket: newBucket(ctx.now) }, replies: [{ t: 'welcome', you: person }], presenceChanged: true };
  }

  if (state.stage !== 'attached') {
    // Unknown state shape (for example after a protocol change): fail closed.
    return { state, replies: [{ t: 'error', reason: 'invalid socket state' }], close: { code: CLOSE_AUTH_FAILED, reason: 'invalid socket state' } };
  }

  // Rate limit every authenticated frame, parseable or not.
  const taken = takeToken(state.bucket, ctx.now);
  const next: SocketState = { ...state, bucket: taken.bucket };
  if (!taken.ok) return { state: next, replies: [{ t: 'error', reason: 'rate limited' }] };
  if (!msg) return { state: next, replies: [{ t: 'error', reason: 'unrecognised message' }] };

  switch (msg.t) {
    case 'auth':
      return { state: next, replies: [{ t: 'error', reason: 'already authenticated' }] };
    case 'ping':
      // Normally answered by the hibernation auto-response before reaching here.
      return { state: next, replies: [{ t: 'pong' }] };
    case 'text': {
      const { publicKey, fingerprint: fp, name } = state.person;
      return { state: next, replies: [], broadcast: [{ t: 'text', from: { publicKey, fingerprint: fp, name }, text: msg.text, at: ctx.now }] };
    }
  }
}
