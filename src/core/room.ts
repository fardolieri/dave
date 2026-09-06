// Per-socket state machine, runtime-neutral. The Durable Object adapter stores the
// returned state in the socket attachment, sends the replies, and closes when told.
// Everything here is plain data plus WebCrypto, so it survives hibernation.
import { fromBase64Url, fingerprint, randomNonce, toBase64Url, verifyAnswer } from './identity';
import { CLOSE_AUTH_FAILED, parseClientMessage, type Identity, type ServerMessage } from './protocol';

export const MAX_AUTH_ATTEMPTS = 3;

export type SocketState =
  | { stage: 'challenge'; nonce: string; attempts: number }
  | { stage: 'attached'; identity: Identity };

export type Outcome = {
  state: SocketState;
  replies: ServerMessage[];
  close?: { code: number; reason: string };
};

export type RoomContext = {
  /** The shared secret, held only by the server. */
  secret: string;
};

/** A socket has just been accepted: challenge it. */
export function openSocket(): Outcome {
  const nonce = toBase64Url(randomNonce());
  return { state: { stage: 'challenge', nonce, attempts: 0 }, replies: [{ t: 'challenge', nonce }] };
}

export async function onMessage(state: SocketState, raw: unknown, ctx: RoomContext): Promise<Outcome> {
  const msg = parseClientMessage(raw);
  if (!msg) return { state, replies: [{ t: 'error', reason: 'unrecognised message' }] };

  if (state.stage === 'challenge') {
    if (msg.t !== 'auth') return { state, replies: [{ t: 'error', reason: 'unauthenticated' }] };
    const publicKeyRaw = fromBase64Url(msg.publicKey);
    const ok = await verifyAnswer({
      secret: ctx.secret,
      nonce: fromBase64Url(state.nonce),
      publicKeyRaw,
      hmac: fromBase64Url(msg.hmac),
      signature: fromBase64Url(msg.signature),
    });
    if (!ok) {
      const attempts = state.attempts + 1;
      const failed: SocketState = { stage: 'challenge', nonce: state.nonce, attempts };
      const replies: ServerMessage[] = [{ t: 'error', reason: 'authentication failed' }];
      if (attempts >= MAX_AUTH_ATTEMPTS) return { state: failed, replies, close: { code: CLOSE_AUTH_FAILED, reason: 'authentication failed' } };
      return { state: failed, replies };
    }
    const identity: Identity = { publicKey: msg.publicKey, fingerprint: await fingerprint(publicKeyRaw), name: msg.name };
    return { state: { stage: 'attached', identity }, replies: [{ t: 'welcome', you: identity }] };
  }

  switch (msg.t) {
    case 'auth':
      return { state, replies: [{ t: 'error', reason: 'already authenticated' }] };
    case 'ping':
      return { state, replies: [{ t: 'pong' }] };
    case 'echo':
      return { state, replies: [{ t: 'echo', text: msg.text }] };
  }
}
