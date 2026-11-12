// Whose heavy processes the hooks hold a turn for (heavy.sh, stop-check.sh, session-start.sh), with real processes:
// node --test scripts/claude/heavy.test.mjs
//
// An agent session is a process named `claude`, so a copy of bash named claude stands in for one. A dev server is a
// `sleep` whose command line reads `vite preview ...`, marked with this run's pid so that the machine's own processes
// (another session at work, on the dev box) never count. Each lives 30 s at most, should the test be killed: until then
// another session's hooks see the leftover among them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const linux = process.platform === 'linux';
const tag = `--heavy-test-${process.pid}`;
const server = (who) => `vite preview ${tag}-${who}`;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Resolved: the hooks name a session's directory as /proc has it.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'heavy-')));
const claude = join(dir, 'claude');
const elsewhere = join(dir, 'other-worktree');
const scoped = join(dir, 'scoped-worktree');
mkdirSync(elsewhere);
mkdirSync(scoped);
const sessions = [];
after(() => {
  for (const s of sessions) try { process.kill(-s.pid, 'SIGKILL'); } catch { /* gone */ }
  spawnSync('pkill', ['-f', `^vite preview ${tag}-`]);
  rmSync(dir, { recursive: true, force: true });
});

// As T3 Code starts sessions: each in a cgroup scope of its own, where systemd-run --user works (the dev box, and a GitHub
// runner too); elsewhere they share one, and the test that needs a scope skips.
const scopes = linux && spawnSync('systemd-run', ['--user', '--scope', '-q', 'true'], { stdio: 'ignore' }).status === 0;
const inScope = (cmd) => (scopes ? ['systemd-run', ['--user', '--scope', '-q', ...cmd]] : [cmd[0], cmd.slice(1)]);

/** Waits until a marked server runs as itself (not as the shell that is about to become it). */
function running(who) {
  for (let i = 0; i < 100; i++) {
    if (spawnSync('pgrep', ['-f', `^${server(who)}`]).status === 0) return;
    spawnSync('sleep', ['0.05']);
  }
  throw new Error(`${server(who)} never started`);
}

/**
 * Runs a hook inside a session of its own that also runs a server of its own (`who`), as an agent's Bash tool would.
 * `nested`: the server runs under a claude the session started (an agent running `claude -p`), not under the session.
 */
function inSession(hook, who, { env = process.env, nested = false } = {}) {
  const start = `exec -a "${server(who)}" sleep 30 >/dev/null 2>&1 &`;
  const script = `${nested ? `"${claude}" -c '${start} wait' &` : start}
    until pgrep -f "^${server(who)}" >/dev/null; do sleep 0.05; done
    echo '{}' | "${join(here, hook)}"; code=$?
    pkill -f "^${server(who)}"; exit $code`;
  return spawnSync(...inScope([claude, '-c', script]), { encoding: 'utf8', env, timeout: 30_000 });
}

/** The lines under a briefing's heading, up to the next one. */
function section(stdout, heading) {
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith(heading));
  if (at < 0) return '';
  const end = lines.findIndex((l, i) => i > at && l.startsWith('- '));
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
}

// Nothing from the network or this machine's accounts: no GitHub token, no PostHog key, no repository.
const quiet = { ...process.env, HOME: dir, XDG_STATE_HOME: dir, CLAUDE_PROJECT_DIR: dir, GH_TOKEN: '', GITHUB_TOKEN: '' };

if (linux) {
  copyFileSync('/bin/bash', claude);
  chmodSync(claude, 0o755);
  // Another session, still running, with a dev server of its own.
  sessions.push(spawn(...inScope([claude, '-c', `exec -a "${server('other')}" sleep 30 & wait`]), { cwd: elsewhere, detached: true, stdio: 'ignore' }));
  // A leftover: let go by a shell that has ended, outside any session (and its scope: on the dev box this test runs in
  // an agent session's, which would take it in). Not holding this test's pipes open.
  spawnSync(...inScope(['/bin/bash', '-c', `(exec -a "${server('orphan')}" sleep 30 &)`]), { stdio: 'ignore' });
  running('other');
  running('orphan');
}

test('the stop hook holds the turn for this session\'s processes and for leftovers, not for another session\'s', { skip: !linux && 'Linux only (/proc)' }, () => {
  const run = inSession('stop-check.sh', 'mine-stop');
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, new RegExp(`This session's[^]*${tag}-mine-stop`));
  assert.match(run.stderr, new RegExp(`Leftovers[^]*${tag}-orphan`));
  assert.doesNotMatch(run.stderr, new RegExp(`${tag}-other`));
});

test('the briefing tells leftovers from another session\'s processes, and names that session\'s directory', { skip: !linux && 'Linux only (/proc)' }, () => {
  const run = inSession('session-start.sh', 'mine-brief', { env: quiet });
  assert.equal(run.status, 0, run.stderr);
  assert.match(section(run.stdout, '- Leftover heavy processes'), new RegExp(`${tag}-orphan`));
  assert.match(section(run.stdout, '- Heavy processes this session started'), new RegExp(`${tag}-mine-brief`));
  assert.match(section(run.stdout, '- Heavy processes of other agent sessions'), new RegExp(`\\d+ in ${escape(elsewhere)}[,)]`));
  assert.doesNotMatch(run.stdout, new RegExp(`${tag}-other`));
});

test('a server another session let go of is still that session\'s, not a leftover, while the session runs in a scope of its own', { skip: !scopes && 'needs systemd-run --user --scope' }, () => {
  // `(cmd &)` hands the server to systemd, as Chromium does with its crash handler: no session above it any more.
  // `& wait`: a last command alone would take the session's place.
  const script = `(exec -a "${server('let-go')}" sleep 30 >/dev/null 2>&1 &); sleep 30 & wait`;
  sessions.push(spawn(...inScope([claude, '-c', script]), { cwd: scoped, detached: true, stdio: 'ignore' }));
  running('let-go');
  const stop = inSession('stop-check.sh', 'mine-scope-stop');
  assert.doesNotMatch(stop.stderr, new RegExp(`${tag}-let-go`));
  const brief = inSession('session-start.sh', 'mine-scope-brief', { env: quiet });
  assert.doesNotMatch(brief.stdout, new RegExp(`${tag}-let-go`));
  // Counted for it: the only process in its directory.
  assert.match(section(brief.stdout, '- Heavy processes of other agent sessions'), new RegExp(`\\b1 in ${escape(scoped)}[,)]`));
});

test('a server under a claude the session started (`claude -p`) is the session\'s own', { skip: !linux && 'Linux only (/proc)' }, () => {
  const run = inSession('stop-check.sh', 'nested', { nested: true });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr.split('Leftovers')[0], new RegExp(`This session's[^]*${tag}-nested`));
});
