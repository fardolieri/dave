import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import { cloudflare } from '@cloudflare/vite-plugin';

// One dev server for both halves: Vite serves the Solid SPA with HMR and runs the
// Worker (and its Room Durable Object) in workerd. `vite build` emits dist/client
// and dist/dave, plus the deploy redirect that `wrangler deploy` follows.
export default defineConfig({
  plugins: [solid(), cloudflare()],
  // Source maps ship to production on purpose: this is a friends app and a readable stack in a friend's console is worth more than hiding code.
  build: { target: 'esnext', sourcemap: true },
});
