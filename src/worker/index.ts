export { Room } from './room';
import { isRoomId } from '../core/rooms';
import { forward, PREFIX } from './posthog';

// Static assets are served by the platform before this code runs (see wrangler.jsonc),
// so the Worker only ever sees the WebSocket upgrade, what goes to PostHog (worker/posthog.ts) and true 404s.
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${PREFIX}/`)) return forward(request, env);
    // One Durable Object per room, named by the room id derived from the invite secret (ADR 0004).
    const roomId = url.pathname.startsWith('/ws/') ? url.pathname.slice(4) : null;
    if (roomId !== null && isRoomId(roomId)) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      // Per-IP cap on upgrade attempts so a stranger hammering the gate never wakes a Room.
      // The binding is optional so local dev and tests work without it.
      const limiter = env.UPGRADE_LIMIT;
      if (limiter) {
        const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const { success } = await limiter.limit({ key });
        if (!success) return new Response('too many attempts', { status: 429 });
      }
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
