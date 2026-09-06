import { DurableObject } from 'cloudflare:workers';
import { CHALLENGE_TIMEOUT_MS, challengeExpired, onMessage, openSocket, presenceSnapshot, type Outcome, type SocketState } from '../core/room';
import { CLOSE_AUTH_FAILED, CLOSE_NOT_CONFIGURED, PING_FRAME, PONG_FRAME, type ServerMessage } from '../core/protocol';

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
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState;
    this.apply(ws, await onMessage(state, message, { secret: this.env.ROOM_SECRET, now: Date.now() }));
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

  /** Closes sockets that never answered their challenge. Runs only while such sockets exist. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let pending = false;
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null;
      if (!state || state.stage !== 'challenge') continue;
      if (challengeExpired(state, now)) ws.close(CLOSE_AUTH_FAILED, 'challenge timed out');
      else pending = true;
    }
    if (pending) await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHALLENGE_TIMEOUT_MS);
  }

  private apply(ws: WebSocket, outcome: Outcome): void {
    ws.serializeAttachment(outcome.state);
    for (const reply of outcome.replies) ws.send(JSON.stringify(reply));
    if (outcome.broadcast) for (const m of outcome.broadcast) this.broadcast(m);
    if (outcome.presenceChanged) this.broadcastPresence();
    if (outcome.close) ws.close(outcome.close.code, outcome.close.reason);
  }

  /** Full snapshot to every attached socket. `leaving` is excluded because it may still be listed while closing. */
  private broadcastPresence(leaving?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((s) => s !== leaving);
    const snapshot = presenceSnapshot(sockets.map((s) => s.deserializeAttachment() as SocketState | null));
    const frame = JSON.stringify(snapshot);
    for (const s of sockets) if (this.isAttached(s)) this.trySend(s, frame);
  }

  private broadcast(m: ServerMessage): void {
    const frame = JSON.stringify(m);
    for (const s of this.ctx.getWebSockets()) if (this.isAttached(s)) this.trySend(s, frame);
  }

  private isAttached(ws: WebSocket): boolean {
    const state = ws.deserializeAttachment() as SocketState | null;
    return !!state && state.stage === 'attached';
  }

  private trySend(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
    } catch {
      // socket is closing; the platform will report it through webSocketClose
    }
  }
}
