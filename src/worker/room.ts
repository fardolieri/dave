import { DurableObject } from 'cloudflare:workers';
import { handleClientMessage } from '../core/room';

// One Room per app. Uses the WebSocket Hibernation API so the object can be
// evicted while sockets stay attached; anything worth keeping lives in the
// per-socket attachment (16 KB cap), never in instance fields.
export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const reply = handleClientMessage(message);
    ws.send(JSON.stringify(reply));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1005/1006 mean "no status" and may not be passed back into close().
    const valid = code === 1000 || (code >= 3000 && code <= 4999);
    ws.close(valid ? code : 1000, reason);
  }
}
