export { Room } from './room';
import { isRoomId } from '../core/rooms';
import { forward, PREFIX } from './posthog';
import { logUpgradeFailed } from './telemetry';

// Static assets are served by the platform before this code runs (see wrangler.jsonc),
// so the Worker only ever sees the WebSocket upgrade, what goes to PostHog (worker/posthog.ts) and true 404s.
export default {
  async fetch(request, env, ctx): Promise<Response> {
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
      // A throw from here on was a bare 500 nobody could read (ticket 55): it is reported, then answered the same way.
      // `attempt`: 0 before the Room was asked (the rate limiter, the stub), then which ask of it failed.
      let attempt = 0;
      try {
        const limiter = env.UPGRADE_LIMIT;
        if (limiter) {
          const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
          const { success } = await limiter.limit({ key });
          if (!success) return new Response('too many attempts', { status: 429 });
        }
        const id = env.ROOM.idFromName(roomId);
        attempt = 1;
        try {
          return await env.ROOM.get(id).fetch(request);
        } catch (e) {
          // Cloudflare's "internal error; reference = …" from the Room's stub, neither retryable nor overloaded, seen on
          // nightly and a preview (ticket 55). The Room is asked once more, on a new stub. Should the first ask have reached
          // it, it holds a socket nobody answers, which its challenge sweep closes after CHALLENGE_TIMEOUT_MS; never in
          // presence. An overloaded Room is not asked again: that would only add to it.
          if ((e as { overloaded?: unknown } | null)?.overloaded === true) throw e;
          logUpgradeFailed(env, ctx, e, 1);
          await new Promise((r) => setTimeout(r, 100));
          attempt = 2;
          return await env.ROOM.get(id).fetch(request);
        }
      } catch (e) {
        logUpgradeFailed(env, ctx, e, attempt);
        return new Response('upgrade failed', { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
