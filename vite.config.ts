import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import solid from '@solidjs/vite-plugin';
import { cloudflare } from '@cloudflare/vite-plugin';
import type { BuildInfo } from './src/client/version';
import { precacheUrls, SW_FILE } from './src/core/precache';

/** The commit this build is made of, and when it was built: a deploy builds right before it uploads. */
function buildInfo(): BuildInfo {
  const git = (...args: string[]): string => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const env = process.env.CLOUDFLARE_ENV ?? '';
  return {
    commit: git('rev-parse', 'HEAD'),
    subject: git('log', '-1', '--format=%s'),
    // Trailers such as Co-Authored-By say nothing about what changed; hard-wrapped lines are rejoined so the dialog wraps them.
    body: git('log', '-1', '--format=%b').replace(/^[\w-]+-by:.*$/gim, '').trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ')).join('\n\n'),
    committedAt: git('log', '-1', '--format=%cI'),
    builtAt: new Date().toISOString(),
    // Deploys run in GitHub Actions (deploy.yml); anything else is a build on someone's machine.
    target: !process.env.GITHUB_ACTIONS ? 'local' : env === 'nightly' ? 'nightly' : env === '' ? 'live' : env,
    dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  };
}

/**
 * The service worker (ticket 33): src/client/sw.ts becomes a second entry of the client build, emitted unhashed at the
 * root, and gets the list of the build's files and a hash of their contents written in, where it says __PRECACHE__.
 * The dev server never registers it (client/update.ts).
 */
function serviceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'dave:service-worker',
    enforce: 'post',
    config: () => ({
      environments: {
        client: {
          build: {
            rollupOptions: {
              input: { index: 'index.html', sw: 'src/client/sw.ts' },
              output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? SW_FILE : 'assets/[name]-[hash].js') },
            },
          },
        },
      },
    }),
    configResolved: (config) => { publicDir = config.publicDir; },
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle(_options, bundle) {
      const sw = bundle[SW_FILE];
      if (sw?.type !== 'chunk') return;
      // The public folder is copied next to the bundle as it is, so its files are read from disk.
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      const contents = new Map<string, string | Uint8Array>();
      for (const [file, out] of Object.entries(bundle)) contents.set(file, out.type === 'chunk' ? out.code : out.source);
      if (publicDir) for (const path of walk(publicDir)) contents.set(relative(publicDir, path).split('\\').join('/'), readFileSync(path));
      const urls = precacheUrls([...contents.keys()]);
      const hash = createHash('sha256');
      for (const file of [...contents.keys()].sort()) if (urls.includes(file === 'index.html' ? '/' : `/${file}`)) hash.update(file).update(contents.get(file)!);
      sw.code = sw.code.replaceAll('__PRECACHE__', JSON.stringify({ version: hash.digest('hex').slice(0, 16), urls }));
    },
  };
}

// One dev server for both halves: Vite serves the Solid SPA with HMR and runs the
// Worker (and its Room Durable Object) in workerd. `vite build` emits dist/client
// and dist/dave, plus the deploy redirect that `wrangler deploy` follows.
export default defineConfig({
  plugins: [solid(), cloudflare(), serviceWorker()],
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  // Source maps ship to production on purpose: this is a friends app and a readable stack in a friend's console is worth more than hiding code.
  build: { target: 'esnext', sourcemap: true },
  // The voice worklet (client/voice.worklet.ts) is bundled like a worker; a worklet loads ES modules only.
  worker: { format: 'es' },
});
