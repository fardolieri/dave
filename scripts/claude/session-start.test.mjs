// The briefing installs a worktree's dependencies when they are missing or old (session-start.sh), with a stand-in pnpm:
// node --test scripts/claude/session-start.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'briefing-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A pnpm that writes down how it was called, then installs (the file pnpm itself writes last) or fails as pnpm does.
const bin = join(dir, 'bin');
const calls = join(dir, 'calls');
mkdirSync(bin);
writeFileSync(join(bin, 'pnpm'), `#!/bin/sh
echo "$*" >> "${calls}"
if [ -e fail ]; then echo " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile"; exit 1; fi
mkdir -p node_modules && touch node_modules/.modules.yaml
`);
chmodSync(join(bin, 'pnpm'), 0o755);

let n = 0;
const project = (...files) => {
  const p = join(dir, `project-${++n}`);
  mkdirSync(p);
  for (const f of files) writeFileSync(join(p, f), '');
  return p;
};
// No token and no key: the questions asked of GitHub and PostHog stay out of it.
const briefing = (p) => {
  rmSync(calls, { force: true });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, XDG_STATE_HOME: dir, CLAUDE_PROJECT_DIR: p, GH_TOKEN: '', GITHUB_TOKEN: '' };
  const run = spawnSync('bash', [join(here, 'session-start.sh')], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { said: run.stdout, called: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
};

test('a worktree with no node_modules gets its dependencies, once', () => {
  const p = project('pnpm-lock.yaml');
  const first = briefing(p);
  assert.match(first.said, /^- Dependencies installed/m);
  assert.deepEqual(first.called, ['install --frozen-lockfile --prefer-offline']);
  assert.ok(existsSync(join(p, 'node_modules/.modules.yaml')));
  const second = briefing(p);
  assert.doesNotMatch(second.said, /[Dd]ependencies/);
  assert.deepEqual(second.called, []);
});

test('a lockfile newer than what is installed is installed again', () => {
  const p = project('pnpm-lock.yaml');
  briefing(p);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(p, 'pnpm-lock.yaml'), later, later);
  const again = briefing(p);
  assert.match(again.said, /^- Dependencies installed/m);
  assert.equal(again.called.length, 1);
});

test('an install that fails is a warning with its exit code, and the briefing goes on', () => {
  const p = project('pnpm-lock.yaml', 'fail');
  const { said } = briefing(p);
  assert.match(said, /^- WARNING: dependencies are missing or old, and 'pnpm install --frozen-lockfile' failed \(exit 1;/m);
  assert.match(said, /MB memory available/);
});

// As the night shift's worktree had the main checkout's until 2026-11-19: an install through the link would be into that.
test('a node_modules that is a link to another checkout is left alone, however old', () => {
  const p = project('pnpm-lock.yaml');
  const other = join(project(), 'node_modules');
  mkdirSync(other);
  symlinkSync(other, join(p, 'node_modules'));
  const { said, called } = briefing(p);
  assert.doesNotMatch(said, /[Dd]ependencies/);
  assert.deepEqual(called, []);
});

test('a directory with no lockfile is left alone', () => {
  const { said, called } = briefing(project());
  assert.doesNotMatch(said, /[Dd]ependencies/);
  assert.deepEqual(called, []);
});
