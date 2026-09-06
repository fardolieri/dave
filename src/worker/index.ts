export { Room } from './room';

// Static assets are served by the platform before this code runs (see wrangler.jsonc),
// so the Worker only ever sees the WebSocket upgrade and true 404s.
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const id = env.ROOM.idFromName('the-room');
      return env.ROOM.get(id).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
