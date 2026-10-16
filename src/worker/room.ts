import { DurableObject } from 'cloudflare:workers';
import { CHALLENGE_TIMEOUT_MS, challengeExpired, onMessage, openSocket, presenceSnapshot, settleTurnUser, MAX_TURN_USERS, type Outcome, type SocketState } from '../core/room';
import { CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, PING_FRAME, PONG_FRAME, type Person, type ServerMessage } from '../core/protocol';
import { ICE_TTL_SECONDS } from '../core/mesh';
import { mintIceServers, revokeIce } from './turn';
import { logRejected } from './telemetry';

/** A socket whose last sign of life is older than this is dropped by the sweep (spec §4). */
export const SILENT_TIMEOUT_MS = 90_000;
export const SWEEP_INTERVAL_MS = 60_000;
export const CLOSE_SILENT = 4003;
/** An attached socket the runtime reported an error on is closed with this, should it still reach the client (it reconnects). */
export const CLOSE_ERRORED = 4005;
/** Storage key of the room's verifier, set by the first friend to enter (ADR 0004). */
const AUTH_KEY = 'authKey';
/**
 * Storage key prefix of the TURN users a friend's sockets left behind, by public key (letGo): `{ users, since }`. Her peer
 * connections can outlive her socket (ticket 31), and media can flow with every socket gone (two phones talking with
 * their screens off are both swept), which the server cannot see; a revoked user ends a relayed call at the
 * allocation's next refresh. So they wait for her next join, and only her Leave revokes them; otherwise they run out
 * after ICE_TTL_SECONDS, and the sweep then forgets them.
 */
const AWAY_PREFIX = 'away:';
type Away = { users: string[]; since: number };
/** An entry as stored, or null for one of a shape this build does not know (an earlier build's): no entry. */
const awayOf = (v: unknown): Away | null => {
  const a = v as Partial<Away> | null | undefined;
  return a != null && typeof a === 'object' && Array.isArray(a.users) && a.users.every((u) => typeof u === 'string') && typeof a.since === 'number' ? (a as Away) : null;
};

/**
 * One line in Workers observability per socket end the runtime reports: does the Room ever hear of a socket the network
 * cut (1006), and how long after it was let in (ticket 54)? `attached` is whether it was still in presence; a socket the
 * Room had told to close already is `closing`. `age_ms` counts from the welcome, or from the challenge for a socket never
 * let in. No names or keys.
 */
function logEnd(event: 'close' | 'error', code: number | null, state: SocketState | null): void {
  const since = state?.stage === 'attached' || state?.stage === 'closing' ? state.attachedAt : state?.stage === 'challenge' ? state.since : undefined;
  console.log('socket end', JSON.stringify({ event, code, stage: state?.stage ?? null, attached: state?.stage === 'attached', age_ms: since === undefined ? null : Date.now() - since }));
}

// One Room per room id (ADR 0004). Uses the WebSocket Hibernation API so the object can be
// evicted while sockets stay attached. The per-socket state machine lives in
// the attachment (16 KB cap); this class deliberately has no fields of its own,
// so nothing is lost when the object is evicted and re-created.
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pings are answered at the edge without waking this object (spec §4).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const authKey = await this.ctx.storage.get<string>(AUTH_KEY);
    await this.apply(server, openSocket(Date.now(), authKey === undefined));
    await this.scheduleSweep(CHALLENGE_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState;
    const others = this.ctx.getWebSockets().filter((s) => s !== ws).map((s) => s.deserializeAttachment() as SocketState | null);
    // The verifier is only needed to check an answer; attached sockets never touch storage.
    const authKey = state.stage === 'challenge' ? (await this.ctx.storage.get<string>(AUTH_KEY)) ?? null : null;
    const outcome = await onMessage(state, message, {
      authKey,
      now: Date.now(),
      others: others.flatMap((s) => (s && s.stage === 'attached' ? [s.person] : [])),
      mintIce: (ttlSeconds) => mintIceServers(this.env, ttlSeconds),
    });
    await this.apply(ws, outcome);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1005/1006 mean "no status" and may not be passed back into close().
    const valid = code === 1000 || (code >= 3000 && code <= 4999);
    const state = ws.deserializeAttachment() as SocketState | null;
    logEnd('close', code, state);
    if (state?.stage === 'attached') this.letGo(ws, state); // before the close, while the attachment is surely writable
    ws.close(valid ? code : 1000, reason);
    if (state?.stage !== 'attached') return; // never in presence (a challenge), or out of it since it was told to close
    this.broadcastPresence(ws);
  }

  /**
   * The runtime may keep an errored socket in getWebSockets() until its close comes, so it is marked closing here, like a
   * superseded one: before, the next snapshot (someone else joining or muting) listed the friend again, until the sweep.
   */
  async webSocketError(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null;
    logEnd('error', null, state);
    if (state?.stage !== 'attached') return;
    this.letGo(ws, state);
    try { ws.close(CLOSE_ERRORED, 'socket error'); } catch { /* already gone */ }
    this.broadcastPresence(ws);
  }

  /**
   * Sweep: close unanswered challenges after their window and attached sockets that
   * have shown no sign of life for SILENT_TIMEOUT_MS. Runs while any socket exists,
   * so ghost visitors clear within about 90 s (spec §4, amended 2026-09-06).
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let dropped = false;
    let attachedLeft = 0;
    let challengesLeft = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state) continue;
      if (state.stage === 'challenge') {
        if (challengeExpired(state, now)) ws.close(CLOSE_AUTH_FAILED, 'challenge timed out');
        else challengesLeft++;
        continue;
      }
      if (state.stage === 'closing') { try { ws.close(CLOSE_SILENT, 'still closing'); } catch { /* handshake under way */ } continue; }
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? state.attachedAt;
      if (now - lastPing >= SILENT_TIMEOUT_MS) {
        this.letGo(ws, state); // out of presence now, whenever the runtime lets go
        ws.close(CLOSE_SILENT, 'no sign of life');
        dropped = true;
      } else attachedLeft++;
    }
    if (dropped) this.broadcastPresence();
    // TURN users left behind that have run out are forgotten, not revoked; so is an entry this build cannot read.
    for (const [key, value] of [...this.ctx.storage.kv.list({ prefix: AWAY_PREFIX })]) {
      const away = awayOf(value);
      if (!away || now - away.since >= ICE_TTL_SECONDS * 1000) this.ctx.storage.kv.delete(key);
    }
    // Pending challenges need the short interval; attached sockets only the long one.
    if (challengesLeft > 0) await this.scheduleSweep(CHALLENGE_TIMEOUT_MS);
    else if (attachedLeft > 0) await this.scheduleSweep(SWEEP_INTERVAL_MS);
  }

  private async scheduleSweep(inMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const wanted = Date.now() + inMs;
    if (current === null || current > wanted) await this.ctx.storage.setAlarm(wanted);
  }

  private async apply(ws: WebSocket, outcome: Outcome): Promise<void> {
    if (outcome.storeAuthKey) await this.ctx.storage.put(AUTH_KEY, outcome.storeAuthKey);
    ws.serializeAttachment(outcome.state);
    for (const reply of outcome.replies) ws.send(JSON.stringify(reply));
    if (outcome.broadcast) for (const m of outcome.broadcast) this.fanOut(m);
    if (outcome.relay) this.deliver(outcome.relay.to, outcome.relay.message);
    const superseded = outcome.supersede ? this.supersede(ws, outcome.supersede) : [];
    if (outcome.takeOverTurn) this.takeOverTurn(ws, outcome.takeOverTurn);
    if (outcome.presenceChanged) this.broadcastPresence(...superseded);
    for (const user of outcome.revokeTurn ?? []) this.ctx.waitUntil(revokeIce(this.env, user));
    if (outcome.close) ws.close(outcome.close.code, outcome.close.reason);
    if (outcome.rejected) logRejected(this.env, this.ctx, outcome.rejected);
    if (outcome.after) {
      // State is already stored; other messages may interleave with this I/O safely, a Leave or the close among them.
      const { replies, minted } = await outcome.after();
      if (!minted) { for (const reply of replies) this.trySend(ws, JSON.stringify(reply)); return; } // a file link's: not tracked (core/room.ts)
      const settled = settleTurnUser(ws.deserializeAttachment() as SocketState | null, minted);
      if ('revoke' in settled) {
        if (settled.revoke) this.ctx.waitUntil(revokeIce(this.env, settled.revoke));
        return; // its answer is not sent either
      }
      ws.serializeAttachment(settled.state);
      for (const reply of replies) this.trySend(ws, JSON.stringify(reply));
    }
  }

  /**
   * Close every other socket attached under this identity and return them, so the caller can leave them out of the
   * next snapshot. They are marked closing first: a dead socket (the client reconnected before the server noticed)
   * can linger in getWebSockets() long after close(), and must not be listed or written to meanwhile.
   */
  private supersede(keeper: WebSocket, publicKey: string): WebSocket[] {
    const gone: WebSocket[] = [];
    for (const s of this.ctx.getWebSockets()) {
      if (s === keeper) continue;
      const state = s.deserializeAttachment() as SocketState | null;
      if (state?.stage !== 'attached' || state.person.publicKey !== publicKey) continue;
      this.letGo(s, state);
      try { s.close(CLOSE_SUPERSEDED, 'opened elsewhere'); } catch { /* already gone */ }
      gone.push(s);
    }
    return gone;
  }

  /**
   * Out of presence for good: marked closing. Its TURN users wait for this friend's next join (AWAY_PREFIX), since her
   * peer connections may outlive this socket. The caller closes it.
   */
  private letGo(ws: WebSocket, state: Extract<SocketState, { stage: 'attached' }>): void {
    ws.serializeAttachment({ stage: 'closing', attachedAt: state.attachedAt } satisfies SocketState);
    if (!state.turnUsers?.length) return;
    const key = AWAY_PREFIX + state.person.publicKey;
    const users = [...(awayOf(this.ctx.storage.kv.get(key))?.users ?? []), ...state.turnUsers].slice(-MAX_TURN_USERS);
    this.ctx.storage.kv.put<Away>(key, { users, since: Date.now() });
  }

  /**
   * A friend's join takes over the TURN users her earlier sockets left (letGo); her Leave revokes them. On the join, not
   * on coming back: a reconnect joins again at once, while a tab reloaded past its Rejoin may never join.
   */
  private takeOverTurn(ws: WebSocket, publicKey: string): void {
    const state = ws.deserializeAttachment() as SocketState | null;
    const key = AWAY_PREFIX + publicKey;
    const away = awayOf(this.ctx.storage.kv.get(key));
    if (state?.stage !== 'attached' || !away) return;
    this.ctx.storage.kv.delete(key);
    ws.serializeAttachment({ ...state, turnUsers: [...away.users, ...(state.turnUsers ?? [])].slice(-MAX_TURN_USERS) });
  }

  /** The presence snapshot as computed right now from attachments alone. Public so tests can compare a fresh instance's view. */
  currentPresence(...leaving: WebSocket[]): ServerMessage {
    const sockets = this.ctx.getWebSockets().filter((s) => !leaving.includes(s));
    return presenceSnapshot(sockets.map((s) => s.deserializeAttachment() as SocketState | null));
  }

  /** Full snapshot to every attached socket. `leaving` sockets are excluded because they may still be listed while closing. */
  private broadcastPresence(...leaving: WebSocket[]): void {
    this.fanOut(this.currentPresence(...leaving), leaving);
  }

  private fanOut(m: ServerMessage, exclude: WebSocket[] = []): void {
    const frame = JSON.stringify(m);
    for (const s of this.ctx.getWebSockets()) if (!exclude.includes(s) && this.personOf(s)) this.trySend(s, frame);
  }

  private deliver(publicKey: string, m: ServerMessage): void {
    const frame = JSON.stringify(m);
    for (const s of this.ctx.getWebSockets()) if (this.personOf(s)?.publicKey === publicKey) this.trySend(s, frame);
  }

  private personOf(ws: WebSocket): Person | null {
    const state = ws.deserializeAttachment() as SocketState | null;
    return state && state.stage === 'attached' ? state.person : null;
  }

  private trySend(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
    } catch {
      // socket is closing; the platform will report it through webSocketClose
    }
  }
}
