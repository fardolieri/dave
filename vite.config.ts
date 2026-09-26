import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import { cloudflare } from '@cloudflare/vite-plugin';
import type { BuildInfo } from './src/client/version';

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

// One dev server for both halves: Vite serves the Solid SPA with HMR and runs the
// Worker (and its Room Durable Object) in workerd. `vite build` emits dist/client
// and dist/dave, plus the deploy redirect that `wrangler deploy` follows.
export default defineConfig({
  plugins: [solid(), cloudflare()],
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  // Source maps ship to production on purpose: this is a friends app and a readable stack in a friend's console is worth more than hiding code.
  build: { target: 'esnext', sourcemap: true },
});
