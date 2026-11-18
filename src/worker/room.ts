import { DurableObject } from 'cloudflare:workers';
import { CHALLENGE_TIMEOUT_MS, challengeExpired, onMessage, openSocket, presenceSnapshot, settleTurnUser, MAX_TURN_USERS, type Outcome, type SocketState } from '../core/room';
import { CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, PING_FRAME, PONG_FRAME, type ServerMessage, type WirePerson as Person } from '../core/protocol';
import { ICE_TTL_SECONDS } from '../core/mesh';
import { mintIceServers, revokeIce } from './turn';
import { logRejected } from './telemetry';
import { STORE_NAME } from './store';
import type { KeptEntry } from '../core/protocol';
import { fromBase64Url, toBase64Url } from '../core/identity';

/** A socket whose last sign of life is older than this is dropped by the sweep (spec §4). */
export const SILENT_TIMEOUT_MS = 90_000;
/** How often the sweep looks for silent sockets, while at least SWEEP_FROM friends are in the room (`alarm`). */
export const SWEEP_INTERVAL_MS = 60_000;
/**
 * The sweep runs while this many sockets are attached, not fewer: a socket gone silent is dropped so that the friends
 * still there see it go, and a friend alone has nobody to tell. Every sweep is a request to the Room, and a friend with
 * the app open sits alone in most rooms of two (ADR 0011): on 2026-11-17 the sweep was 10,600 of the live site's 13,000
 * requests to Durable Objects, 200 to 560 a day in rooms that saw 13 to 80 frames (ticket 89). A ghost left alone is
 * dropped as the next friend comes in, before she is told who is there (`webSocketMessage`).
 */
export const SWEEP_FROM = 2;
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
/**
 * Storage key of the room id as the first socket's URL had it (`/ws/<room id>`), for the server's history (ADR 0009): in
 * case the runtime does not give this object the name it was made from (`ctx.id.name`).
 */
const ROOM_ID = 'roomId';
type Away = { users: string[]; since: number };
/** Whether the TURN users of an entry have run out by `now`: ICE_TTL_SECONDS after the friend's last sign of life. */
const runOut = (away: Away, now: number): boolean => now - away.since >= ICE_TTL_SECONDS * 1000;
/** An entry as stored, or null for one of a shape this build does not know (an earlier build's): no entry. */
const awayOf = (v: unknown): Away | null => {
  const a = v as Partial<Away> | null | undefined;
  return a != null && typeof a === 'object' && Array.isArray(a.users) && a.users.every((u) => typeof u === 'string') && typeof a.since === 'number' ? (a as Away) : null;
};

/**
 * One line in Workers observability per socket end the runtime reports: does the Room ever hear of a socket the network
 * cut (1006), and how long after it was let in (ticket 54)? `attached` is whether it was still in presence; a socket the
 * Room had told to close already is `closing`. `age_ms` counts from the welcome, or from the challenge for a socket never
 * let in (`let_in` false). No names or keys.
 */
function logEnd(event: 'close' | 'error', code: number | null, state: SocketState | null): void {
  const since = state?.stage === 'attached' ? state.attachedAt : state?.stage === 'closing' ? state.attachedAt ?? state.since : state?.stage === 'challenge' ? state.since : undefined;
  const letIn = state?.stage === 'attached' || (state?.stage === 'closing' && state.attachedAt !== undefined);
  console.log('socket end', JSON.stringify({ event, code, stage: state?.stage ?? null, attached: state?.stage === 'attached', let_in: letIn, age_ms: since === undefined ? null : Date.now() - since }));
}

// One Room per room id (ADR 0004). Uses the WebSocket Hibernation API so the object can be
// evicted while sockets stay attached. The per-socket state machine lives in
// the attachment (16 KB cap); this class deliberately has no fields of its own,
// so nothing is lost when the object is evicted and re-created. One exception, `keeping`: work under way, which keeps
// the object awake until it is done.
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
    const fromUrl = new URL(request.url).pathname.split('/').pop();
    if (this.ctx.id.name === undefined && fromUrl && this.ctx.storage.kv.get(ROOM_ID) === undefined) this.ctx.storage.kv.put(ROOM_ID, fromUrl);
    const authKey = await this.ctx.storage.get<string>(AUTH_KEY);
    await this.apply(server, openSocket(Date.now(), authKey === undefined));
    await this.scheduleSweep(CHALLENGE_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState;
    // An answer to the challenge may let a friend in: whoever went silent meanwhile goes first, so that she is not told
    // of a ghost. In a room nobody else was in, no sweep looked (SWEEP_FROM); with the sweep running, it finds one gone
    // silent since the last sweep, if any. Never at the cost of her answer: a write that fails here (letGo, the free
    // plan's rows used up) loses the ghost's TURN users, which then run out unrevoked; she is closed all the same.
    if (state.stage === 'challenge') {
      const { dropped, failed } = this.dropSilent(Date.now());
      if (dropped) this.broadcastPresence();
      if (failed) console.log('silent dropped, its TURN users not kept', JSON.stringify({ reason: String(failed) }));
    }
    const others = this.ctx.getWebSockets().filter((s) => s !== ws).map((s) => s.deserializeAttachment() as SocketState | null);
    // The verifier is only needed to check an answer; attached sockets never touch storage.
    const authKey = state.stage === 'challenge' ? (await this.ctx.storage.get<string>(AUTH_KEY)) ?? null : null;
    const outcome = await onMessage(state, message, {
      authKey,
      now: Date.now(),
      others: others.flatMap((s) => (s && s.stage === 'attached' ? [s.person] : [])),
      mintIce: (ttlSeconds) => mintIceServers(this.env, ttlSeconds),
      history: async (since) => {
        const room = this.roomId();
        if (room === undefined) return null;
        // After this room's own keeps under way: a text broadcast a moment ago is in the answer, or comes live.
        await this.keeping;
        try {
          return await this.store().since(room, since);
        } catch (e) {
          console.log('history not served', JSON.stringify({ reason: String(e) }));
          return null;
        }
      },
      keepPiece: (writer, id, sealed, at) => this.keepPiece(writer, id, sealed, at),
      forget: (writer, before) => this.forget(writer, before),
      piece: async (id) => {
        const room = this.roomId();
        if (room === undefined) return null;
        try {
          const sealed = await this.store().piece(room, id);
          return sealed ? toBase64Url(sealed) : null;
        } catch (e) {
          console.log('piece not served', JSON.stringify({ reason: String(e) }));
          return null;
        }
      },
    });
    await this.apply(ws, outcome);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1005/1006 mean "no status" and may not be passed back into close().
    const valid = code === 1000 || (code >= 3000 && code <= 4999);
    const state = ws.deserializeAttachment() as SocketState | null;
    logEnd('close', code, state);
    this.end(ws, valid ? code : 1000, reason); // the answer to its close; none to a socket this Room closed first
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
    this.end(ws, CLOSE_ERRORED, 'socket error');
    this.broadcastPresence(ws);
  }

  /**
   * Sweep: close unanswered challenges after their window and attached sockets that have shown no sign of life for
   * SILENT_TIMEOUT_MS. Runs while a challenge is open, and while SWEEP_FROM friends are in the room, so a ghost clears
   * within about 90 s for those who see it (spec §4, amended 2026-09-06), and before a friend who comes in later sees it.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let challengesLeft = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (state?.stage !== 'challenge') continue;
      if (challengeExpired(state, now)) this.end(ws, CLOSE_AUTH_FAILED, 'challenge timed out');
      else challengesLeft++;
    }
    const { dropped, attachedLeft, failed } = this.dropSilent(now);
    if (dropped) this.broadcastPresence();
    // Not thrown: a retry of the alarm finds her closing already and cannot keep her TURN users either.
    if (failed) console.log('silent dropped, its TURN users not kept', JSON.stringify({ reason: String(failed) }));
    // TURN users left behind that have run out are forgotten, not revoked; so is an entry this build cannot read.
    for (const [key, value] of [...this.ctx.storage.kv.list({ prefix: AWAY_PREFIX })]) {
      const away = awayOf(value);
      if (!away || runOut(away, now)) this.ctx.storage.kv.delete(key);
    }
    // Pending challenges need the short interval; friends together only the long one; a friend alone none.
    if (challengesLeft > 0) await this.scheduleSweep(CHALLENGE_TIMEOUT_MS);
    else if (attachedLeft >= SWEEP_FROM) await this.scheduleSweep(SWEEP_INTERVAL_MS);
  }

  /** How many sockets are in presence. */
  private attachedCount(): number {
    return this.ctx.getWebSockets().filter((ws) => this.personOf(ws)).length;
  }

  /**
   * Closes the attached sockets silent for SILENT_TIMEOUT_MS, and says whether it closed any and how many are left. A
   * socket whose TURN users could not be kept (letGo's write failing, the free plan's rows used up) is closed all the
   * same, and so are the others: the failure is handed back, not thrown, so that the friends still there are told.
   */
  private dropSilent(now: number): { dropped: boolean; attachedLeft: number; failed?: unknown } {
    let dropped = false;
    let attachedLeft = 0;
    let failed: unknown;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      // A challenge is the alarm's; a socket closing is closed already, and never twice (`end`): it goes when its client
      // answers, or its connection ends.
      if (state?.stage !== 'attached') continue;
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? state.attachedAt;
      if (now - lastPing >= SILENT_TIMEOUT_MS) {
        // Out of presence now, whenever the runtime lets go. Her TURN users wait from her last sign of life: a friend
        // alone was swept by no one, and is dropped only as the next comes in, maybe hours on.
        try { this.end(ws, CLOSE_SILENT, 'no sign of life', lastPing); } catch (e) { failed ??= e; }
        dropped = true;
      } else attachedLeft++;
    }
    return { dropped, attachedLeft, failed };
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
    // A friend let in (an attach supersedes her older sockets, if any): friends together from now on start the sweep,
    // whatever alarm happens to be pending (SWEEP_FROM).
    if (outcome.supersede && this.attachedCount() >= SWEEP_FROM) await this.scheduleSweep(SWEEP_INTERVAL_MS);
    for (const user of outcome.revokeTurn ?? []) this.ctx.waitUntil(revokeIce(this.env, user));
    if (outcome.close) this.end(ws, outcome.close.code, outcome.close.reason);
    if (outcome.rejected) logRejected(this.env, this.ctx, outcome.rejected);
    if (outcome.keep) this.keep(outcome.keep);
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
      this.end(s, CLOSE_SUPERSEDED, 'opened elsewhere');
      gone.push(s);
    }
    return gone;
  }

  /**
   * Closes a socket, once: every close of this Room goes through here. It is marked closing first, in its attachment,
   * and one marked so is left alone, whoever asks: a later sweep, or its own close coming in at last.
   *
   * Never twice, because the runtime forgets. It ignores a second close() only while it remembers the first, and a
   * socket woken from hibernation a second time has lost that note (workerd, api/web-socket.c++: `closedOutgoingForHib`
   * is not restored with `closedOutgoing`). A close() after that queues a second close frame, which nothing reads, the
   * first having gone through: the write waits until the connection ends, and the Room stays awake, and billed, as
   * long. A client the network cut off answers no close, and its connection takes a quarter of an hour to end. The
   * sweep closed such sockets again every minute ("still closing"): on 2026-11-16 a friend's line dropping again and
   * again kept the Rooms awake until the account's day of Durable Object time was used up (the Workers Free plan,
   * core/relayusage.ts), and no room let anyone in until midnight UTC.
   */
  private end(ws: WebSocket, code: number, reason: string, lastSeen = Date.now()): void {
    const state = ws.deserializeAttachment() as SocketState | null;
    if (state?.stage === 'closing') return;
    // The mark before the close, while the attachment is surely writable; the close before anything that can fail
    // (`letGo` writes to storage), so that a socket marked closing is one that was closed.
    ws.serializeAttachment({ stage: 'closing', ...(state?.stage === 'attached' ? { attachedAt: state.attachedAt } : state?.stage === 'challenge' ? { since: state.since } : {}) } satisfies SocketState);
    try { ws.close(code, reason); } catch { /* already gone */ }
    if (state?.stage === 'attached') this.letGo(state, lastSeen);
  }

  /**
   * A socket out of presence for good (`end`): its TURN users wait for this friend's next join (AWAY_PREFIX), since her
   * peer connections may outlive it.
   */
  private letGo(state: Extract<SocketState, { stage: 'attached' }>, since: number): void {
    if (!state.turnUsers?.length) return;
    const key = AWAY_PREFIX + state.person.publicKey;
    const users = [...(awayOf(this.ctx.storage.kv.get(key))?.users ?? []), ...state.turnUsers].slice(-MAX_TURN_USERS);
    this.ctx.storage.kv.put<Away>(key, { users, since });
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
    // Run out, and not yet forgotten: no sweep looks while a friend is alone in the room (SWEEP_FROM).
    if (runOut(away, Date.now())) return;
    ws.serializeAttachment({ ...state, turnUsers: [...away.users, ...(state.turnUsers ?? [])].slice(-MAX_TURN_USERS) });
  }

  /**
   * Hands a text or file announcement just broadcast to the server's history (ADR 0009, worker/store.ts). The room is the
   * name this object was made from, its room id. Should the Store not take it (the free plan's daily writes used up, say),
   * the room goes on as before: friends online have it, and only those away miss it.
   */
  private keep(entry: KeptEntry): void {
    const room = this.roomId();
    if (room === undefined) { console.log('history not kept', JSON.stringify({ reason: 'no room id' })); return; }
    const kept = this.keeping.then(() => this.store().keep(room, entry)).then(
      (ok) => { if (!ok) console.log('history not kept', JSON.stringify({ reason: 'daily share used up' })); },
      (e: unknown) => console.log('history not kept', JSON.stringify({ reason: String(e) })),
    );
    this.keeping = kept;
    this.ctx.waitUntil(kept);
  }

  /**
   * Hands a piece of a file to the server's history (ADR 0009), and says whether it is kept: beside the texts' keeps, not
   * after them, so a file's pieces hold up no sync. 'failed' asks the sender's app to send it again; 'not today' not.
   */
  private keepPiece(writer: string, id: string, sealed: string, at: number): Promise<'kept' | 'not today' | 'failed'> {
    const kept = this.keepPieceNow(writer, id, sealed, at);
    this.pieceKeeps.add(kept);
    void kept.finally(() => this.pieceKeeps.delete(kept));
    return kept;
  }
  private async keepPieceNow(writer: string, id: string, sealed: string, at: number): Promise<'kept' | 'not today' | 'failed'> {
    const room = this.roomId();
    const bytes = fromBase64Url(sealed);
    if (room === undefined || !bytes) return 'not today';
    try {
      if (await this.store().keepPiece(room, writer, id, bytes, at)) return 'kept';
      console.log('piece not kept', JSON.stringify({ reason: 'daily share used up' }));
      return 'not today';
    } catch (e) {
      console.log('piece not kept', JSON.stringify({ reason: String(e) }));
      return 'failed';
    }
  }

  /** Pieces on their way to the Store: a `forget` waits for them, so none sent before it is kept after it. */
  private pieceKeeps = new Set<Promise<unknown>>();

  /**
   * Deletes what a friend wrote in this room from the server's history (ADR 0009): after this room's keeps and pieces
   * under way, and before those that come after, so what was sent before the `forget` goes and what comes after stays.
   * False when the Store's daily share of writes ran out first, or it failed: the friend's app asks again.
   */
  private forget(writer: string, before: number): Promise<boolean> {
    const room = this.roomId();
    if (room === undefined) return Promise.resolve(false);
    const pieces = [...this.pieceKeeps];
    const done = this.keeping.then(() => Promise.allSettled(pieces)).then(() => this.store().forget(room, writer, before)).catch((e: unknown) => {
      console.log('history not forgotten', JSON.stringify({ reason: String(e) }));
      return false;
    });
    this.keeping = done.then(() => {});
    this.ctx.waitUntil(done);
    return done;
  }

  /**
   * This room's keeps, one after another, so they reach the Store in the order they were broadcast and a sync waits for
   * them. A field, though this class keeps none (above): the object stays awake while one is under way, and once they are
   * done there is nothing to wait for.
   */
  private keeping: Promise<void> = Promise.resolve();

  private roomId(): string | undefined {
    return this.ctx.id.name ?? this.ctx.storage.kv.get<string>(ROOM_ID);
  }

  private store() {
    return this.env.STORE.get(this.env.STORE.idFromName(STORE_NAME));
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
