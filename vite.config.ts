import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import solid from '@solidjs/vite-plugin';
import { cloudflare } from '@cloudflare/vite-plugin';
import type { BuildInfo } from './src/client/version';
import { cacheVersion, laterVersion, precacheUrls, SW_FILE } from './src/core/precache';

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

/** The built worker's first line, which the e2e preview server (`e2eServer`) rewrites: `var __PRECACHE__=<json>;`. */
const precacheLine = (precache: { version: string; urls: string[] }): string => `var __PRECACHE__=${JSON.stringify(precache)};`;

/**
 * The service worker (ticket 33): src/client/sw.ts becomes a second entry of the client build, emitted unhashed at the
 * root, and gets the list of the build's files and the build's version (`cacheVersion`: the build time and a hash of
 * the files' contents) written in. The line goes in front of the code, where `__PRECACHE__` is read as a global, so the
 * source map stays right: mappings move down one line, which the map is told, and no column shifts.
 * The dev server never registers it (client/update.ts).
 */
function serviceWorker(build: BuildInfo): Plugin {
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
      sw.code = `${precacheLine({ version: cacheVersion(build.builtAt, hash.digest('hex').slice(0, 16)), urls })}\n${sw.code}`;
      // An empty first line in the mappings: every generated line is one further down than the map was made for.
      const map = bundle[`${SW_FILE}.map`];
      if (map?.type === 'asset' && typeof map.source === 'string') {
        const parsed = JSON.parse(map.source) as { mappings: string };
        map.source = JSON.stringify({ ...parsed, mappings: `;${parsed.mappings}` });
      }
      if (sw.map) sw.map.mappings = `;${sw.map.mappings}`;
    },
  };
}

/**
 * What the browser suite needs of the server it runs against (playwright.config.ts: `vite preview`), told by cookies a
 * test sets on its own browser context, so tests running side by side never see each other's:
 * - `e2e-deploy=<tag>`: /sw.js is served as a later build would be, its version one second newer and tagged
 *   (`laterVersion`), the code the same. The browser installs it as a new version, and from there every step is the
 *   real one: a cache of its own, the copy of hashed files, the old cache deleted on activation. Playwright cannot
 *   route the browser's fetch of a worker script, and the same bytes under the same URL are no update.
 * - `e2e-outage=1`: every request's connection is cut before an answer, the server as good as gone. A page that still
 *   loads came from the service worker; a file it missed fails the page, which Playwright's routes cannot promise, as
 *   a fetch from inside the worker passes them by.
 * Preview only: a deploy never runs this.
 */
function e2eServer(): Plugin {
  return {
    name: 'dave:e2e-server',
    enforce: 'pre', // ahead of the Cloudflare plugin's handler, which answers everything
    configurePreviewServer(server) {
      // The client build sits in `client/` under the outDir (the Cloudflare plugin's layout); preview's resolved config does not say so.
      const swPath = resolve(server.config.root, server.config.build.outDir, 'client', SW_FILE);
      server.middlewares.use((req, res, next) => {
        const cookies = new Map((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=') as [string, string]));
        if (cookies.get('e2e-outage')) { req.socket.destroy(); return; }
        const tag = cookies.get('e2e-deploy');
        if (!tag || req.url?.split('?')[0] !== `/${SW_FILE}`) { next(); return; }
        const code = readFileSync(swPath, 'utf8');
        const rest = code.slice(code.indexOf('\n'));
        const precache = JSON.parse(code.slice('var __PRECACHE__='.length, code.indexOf('\n') - 1)) as { version: string; urls: string[] };
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(precacheLine({ ...precache, version: laterVersion(precache.version, tag) }) + rest);
      });
    },
  };
}

// One dev server for both halves: Vite serves the Solid SPA with HMR and runs the
// Worker (and its Room Durable Object) in workerd. `vite build` emits dist/client
// and dist/dave, plus the deploy redirect that `wrangler deploy` follows.
const build = buildInfo();

export default defineConfig({
  plugins: [e2eServer(), solid(), cloudflare(), serviceWorker(build)],
  define: { __BUILD__: JSON.stringify(build) },
  // Source maps ship to production on purpose: this is a friends app and a readable stack in a friend's console is worth more than hiding code.
  build: { target: 'esnext', sourcemap: true },
  // The voice worklet (client/voice.worklet.ts) is bundled like a worker; a worklet loads ES modules only.
  worker: { format: 'es' },
});
