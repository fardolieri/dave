import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import { cloudflare } from '@cloudflare/vite-plugin';

// One dev server for both halves: Vite serves the Solid SPA with HMR and runs the
// Worker (and its Room Durable Object) in workerd. `vite build` emits dist/client
// and dist/dave, plus the deploy redirect that `wrangler deploy` follows.
export default defineConfig({
  plugins: [solid(), cloudflare()],
  build: { target: 'esnext' },
});
