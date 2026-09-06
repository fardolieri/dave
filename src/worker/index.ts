export { Room } from './room';

// Static assets are served by the platform before this code runs (see wrangler.jsonc),
// so the Worker only ever sees the WebSocket upgrade and true 404s.
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      // Per-IP cap on upgrade attempts so a stranger hammering the gate never wakes the Room.
      // The binding is optional so local dev and tests work without it.
      const limiter = env.UPGRADE_LIMIT;
      if (limiter) {
        const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const { success } = await limiter.limit({ key });
        if (!success) return new Response('too many attempts', { status: 429 });
      }
      const id = env.ROOM.idFromName('the-room');
      return env.ROOM.get(id).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
