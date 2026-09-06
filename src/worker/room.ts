import { DurableObject } from 'cloudflare:workers';
import { CHALLENGE_TIMEOUT_MS, challengeExpired, onMessage, openSocket, presenceSnapshot, type Outcome, type SocketState } from '../core/room';
import { CLOSE_AUTH_FAILED, CLOSE_NOT_CONFIGURED, PING_FRAME, PONG_FRAME, type Person, type ServerMessage } from '../core/protocol';
import { mintIceServers } from './turn';

/** A socket whose last sign of life is older than this is dropped by the sweep (spec §4). */
export const SILENT_TIMEOUT_MS = 90_000;
export const SWEEP_INTERVAL_MS = 60_000;
export const CLOSE_SILENT = 4003;

// One Room per app. Uses the WebSocket Hibernation API so the object can be
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
    if (!this.env.ROOM_SECRET) {
      server.close(CLOSE_NOT_CONFIGURED, 'room secret not configured');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.apply(server, openSocket(Date.now()));
    await this.scheduleSweep(CHALLENGE_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState;
    const others = this.ctx.getWebSockets().filter((s) => s !== ws).map((s) => s.deserializeAttachment() as SocketState | null);
    const outcome = await onMessage(state, message, {
      secret: this.env.ROOM_SECRET,
      now: Date.now(),
      others: others.flatMap((s) => (s && s.stage === 'attached' ? [s.person] : [])),
      mintIce: () => mintIceServers(this.env),
    });
    this.apply(ws, outcome);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1005/1006 mean "no status" and may not be passed back into close().
    const valid = code === 1000 || (code >= 3000 && code <= 4999);
    ws.close(valid ? code : 1000, reason);
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
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
    let remaining = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state) continue;
      if (state.stage === 'challenge') {
        if (challengeExpired(state, now)) ws.close(CLOSE_AUTH_FAILED, 'challenge timed out');
        else remaining++;
        continue;
      }
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? state.attachedAt;
      if (now - lastPing >= SILENT_TIMEOUT_MS) {
        ws.close(CLOSE_SILENT, 'no sign of life');
        dropped = true;
      } else remaining++;
    }
    if (dropped) this.broadcastPresence();
    if (remaining > 0) await this.scheduleSweep(SWEEP_INTERVAL_MS);
  }

  private async scheduleSweep(inMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const wanted = Date.now() + inMs;
    if (current === null || current > wanted) await this.ctx.storage.setAlarm(wanted);
  }

  private apply(ws: WebSocket, outcome: Outcome): void {
    ws.serializeAttachment(outcome.state);
    for (const reply of outcome.replies) ws.send(JSON.stringify(reply));
    if (outcome.broadcast) for (const m of outcome.broadcast) this.fanOut(m);
    if (outcome.relay) this.deliver(outcome.relay.to, outcome.relay.message);
    if (outcome.presenceChanged) this.broadcastPresence();
    if (outcome.close) ws.close(outcome.close.code, outcome.close.reason);
  }

  /** The presence snapshot as computed right now from attachments alone. Public so tests can compare a fresh instance's view. */
  currentPresence(leaving?: WebSocket): ServerMessage {
    const sockets = this.ctx.getWebSockets().filter((s) => s !== leaving);
    return presenceSnapshot(sockets.map((s) => s.deserializeAttachment() as SocketState | null));
  }

  /** Full snapshot to every attached socket. `leaving` is excluded because it may still be listed while closing. */
  private broadcastPresence(leaving?: WebSocket): void {
    this.fanOut(this.currentPresence(leaving), leaving);
  }

  private fanOut(m: ServerMessage, exclude?: WebSocket): void {
    const frame = JSON.stringify(m);
    for (const s of this.ctx.getWebSockets()) if (s !== exclude && this.personOf(s)) this.trySend(s, frame);
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
