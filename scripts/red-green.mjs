// The red-then-green receipt (.github/workflows/red-green.yml). A regression test proves it covers a bug only if it fails
// without the fix. This runs the tests a branch adds or changes against the app as it was before the branch, and says per
// test whether it fails there.
//
//   node scripts/red-green.mjs plan   whether there is anything to run; writes run= and e2e= to $GITHUB_OUTPUT
//   node scripts/red-green.mjs run    puts the old app in place, runs the touched tests, puts the branch's back, reports
//
// "Before the branch" is the merge base with RECEIPT_BASE (default origin/master), or, on a branch with a "Problem report:"
// commit, the commit right before the first one. Every file the branch changes goes back to it except the test side
// (TEST_SIDE): the tests and their helpers, the test configs, scripts, CI, docs, and the dependencies (package.json and the
// lockfile stay, since putting them back would mean a second install; a fix that is a dependency bump needs the excuse).
//
// Which tests a branch touched: those whose lines the diff changes (touchedTests has the rules). Unit test files run whole
// (they are fast) and only the touched tests are reported; browser tests run by file:line in Chromium only.
//
// Only the regression tests decide: the tests touched by the branch's "Regression test:" and "Problem report:" commits. A
// feature test failing on the old code says nothing about the bug. A test that cannot show anything on the old code is
// inconclusive, never a pass: it skipped there, did not run, its file did not load, or it failed on code the branch adds.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GOOD = 'fails without the change (good: it covers it)';
export const WEAK = 'passes without the change';
const PROBLEM = 'Problem report:';
const REGRESSION = 'Regression test:';
const EXCUSE = 'No regression test:';

/** What stays as the branch has it when the old app goes in. Everything else the branch changes goes back. */
const TEST_SIDE = /^(?:test|e2e|scripts|docs|prototypes|\.github|\.claude|\.scratch)\/|\.md$|^(?:package\.json|pnpm-lock\.yaml|playwright\.config\.ts|vitest\.config\.ts|tsconfig\.e2e\.json)$/;

/** Errors of a test that reaches for code the old app does not have yet: an import, a function, a hook. */
const NEW_CODE = /is not a function|is not a constructor|is not defined|does not provide an export named|is not exported|Cannot find module|Failed to (?:load|resolve)|Cannot read properties of undefined|undefined is not an object/;

/** Outcomes that show nothing either way. */
const UNSURE = new Set(['skipped', 'missing', 'inconclusive']);

/** The runs of lines on the new side that a `git diff -U0` changes, `[from, to]`. A pure deletion marks both lines around the gap. */
export function changedHunks(diff) {
  const hunks = [];
  for (const [, start, count] of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const from = Number(start);
    const n = count === undefined ? 1 : Number(count);
    hunks.push(n === 0 ? [from, from + 1] : [from, from + n - 1]);
  }
  return hunks;
}

/**
 * The tests of one file that the changed hunks touch. `tests` carry a `line`. A hunk that holds test lines touches those
 * tests (a test added after another does not touch the one before through the blank line between them); any other hunk
 * touches the test it falls in, a test reaching up to the next one's line. `hunks` null means the whole file is new. None
 * touched (only helpers or imports changed) means all of them.
 */
export function touchedTests(tests, hunks) {
  if (!hunks) return tests;
  const starts = [...new Set(tests.map((t) => t.line))].sort((a, b) => a - b);
  const hit = new Set();
  for (const [from, to] of hunks) {
    const inside = starts.filter((s) => s >= from && s <= to);
    if (inside.length) inside.forEach((s) => hit.add(s));
    else {
      const owner = starts.findLast((s) => s <= to);
      if (owner !== undefined) hit.add(owner);
    }
  }
  const touched = tests.filter((t) => hit.has(t.line));
  return touched.length ? touched : tests;
}

/**
 * The tests declared in a test file's source, `{ line, title }`, read without running it: `test(…)` and `it(…)` calls with a
 * literal title. Enough to tell which tests one commit touched; the runners give the real list at the branch head.
 */
export function testsIn(source) {
  const re = /^[ \t]*(?:test|it)(?:\.(?:only|skip|fixme|fail|todo|concurrent))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gm;
  return [...source.matchAll(re)].map((m) => ({ line: source.slice(0, m.index).split('\n').length, title: m[2].replace(/\\(.)/g, '$1') }));
}

const isUnit = (path) => /^test\/.*\.test\.ts$/.test(path);
const isE2e = (path) => /^e2e\/.*\.spec\.ts$/.test(path);

/** What the branch changed that matters here, from `git diff --name-status --no-renames`. */
export function classify(nameStatus) {
  const files = nameStatus.split('\n').filter(Boolean).map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
  const kept = files.filter((f) => f.status !== 'D');
  return {
    app: files.filter((f) => !TEST_SIDE.test(f.path)),
    unit: kept.filter((f) => isUnit(f.path)),
    e2e: kept.filter((f) => isE2e(f.path)),
  };
}

/** The commits of `git log --format=%x1e%H%x1f%s%x1f%b`. */
export function commits(log) {
  return log.split('\x1e').filter(Boolean).map((c) => { const [sha = '', subject = '', body = ''] = c.split('\x1f'); return { sha: sha.trim(), subject: subject.trim(), body }; });
}

/**
 * The "Problem report:" commits, each with its excuse: the reason on a body line starting with "No regression test:", for a
 * bug no test can reach.
 */
export function problemReports(list) {
  return list.filter((c) => c.subject.startsWith(PROBLEM))
    .map(({ subject, body }) => ({ subject, excuse: body.match(new RegExp(`^${EXCUSE}[ \\t]*(\\S.*)$`, 'm'))?.[1].trim() }));
}

/** Whether a commit carries regression tests: the test commit before a fix, or the fix itself. */
export const carriesRegression = (c) => c.subject.startsWith(REGRESSION) || c.subject.startsWith(PROBLEM);

/** A test's outcome on the old code from what its runner said. A failure on code the branch adds is inconclusive. */
export function outcome(status, messages = []) {
  if (status === 'failed') return messages.some((m) => NEW_CODE.test(m)) ? 'inconclusive' : 'failed';
  if (status === 'passed' || status === 'skipped' || status === 'missing') return status;
  return 'missing';
}

/**
 * The job's verdict. Without a problem report fix it is informative. With one whose commit does not say why it has no
 * regression test, only the regression tests count (`regression` in each result; `regressions` is how many the branch's
 * commits touched): it fails when there are none, or when every one of them ran and passed on the old code. Any of them
 * inconclusive, or a part that could not run (`incomplete`), leaves it informative.
 */
export function verdict({ problems, results, regressions, incomplete = false }) {
  const owing = problems.filter((p) => !p.excuse);
  const hatch = `if no test can reach the bug, say why on a line starting with "${EXCUSE}" in the commit's body.`;
  if (owing.length) {
    if (!regressions) return { fail: true, text: `This branch fixes a problem report, but its "${REGRESSION}" and "${PROBLEM}" commits add or change no test. A regression test should fail on the old code first (CLAUDE.md: bug fixes start red); ${hatch}` };
    const counted = results.filter((r) => r.regression);
    if (counted.some((r) => r.status === 'failed')) return { fail: false, text: `A regression test fails without the change: the branch carries its red-then-green receipt.` };
    if (incomplete || !counted.length || counted.some((r) => UNSURE.has(r.status))) return { fail: false, text: `No regression test failed without the change, but not every one could show it (inconclusive above), so this stays informative.` };
    return { fail: true, text: `This branch fixes a problem report, but none of its regression tests fails without the change, so nothing shows they cover the bug. A regression test should fail on the old code first (CLAUDE.md: bug fixes start red); ${hatch}` };
  }
  if (problems.length) return { fail: false, text: `Its problem report fixes say why they have no regression test, so no test has to fail without the change.` };
  if (results.some((r) => r.status === 'failed')) return { fail: false, text: `At least one test fails without the change. No problem report fix on this branch, so this is informative.` };
  return { fail: false, text: `No problem report fix on this branch, so no test has to fail without the change.` };
}

const words = { failed: GOOD, passed: WEAK, skipped: 'skipped on the old code (inconclusive)', missing: 'did not run (inconclusive)', inconclusive: 'inconclusive (uses code the branch adds)' };

export function summary({ base, problems, results, notes, outcome, intro }) {
  const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const out = ['## Red-then-green receipt', '', intro ?? `The tests this branch adds or changes, run against the app from ${base}.`, ''];
  for (const p of problems) out.push(`Problem report fix on this branch: "${p.subject}"${p.excuse ? `, without a regression test because: "${p.excuse}"` : ''}.`, '');
  if (results.length) {
    out.push('| Test | Regression test | Without the change |', '|---|---|---|');
    for (const r of results) out.push(`| ${cell(r.where)} ${cell(r.title)} | ${r.regression ? 'yes' : ''} | ${cell(words[r.status] + (r.note ? ` (${r.note})` : ''))} |`);
    out.push('');
  }
  for (const n of notes) out.push(n, '');
  out.push(`**${outcome.fail ? 'Failed' : 'Result'}:** ${outcome.text}`, '');
  return out.join('\n');
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

function report(text) {
  console.log(text);
  if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], text + '\n');
}

/** `path \0 title` of every test the regression commits touched, as each commit left the file. */
function regressionKeys(list) {
  const keys = new Set();
  for (const c of list.filter(carriesRegression)) {
    const files = git('diff-tree', '--no-commit-id', '-r', '--root', '--name-status', '--no-renames', c.sha).split('\n').filter(Boolean)
      .map((l) => { const [status, path] = l.split('\t'); return { status, path }; })
      .filter((f) => f.status !== 'D' && (isUnit(f.path) || isE2e(f.path)));
    for (const f of files) {
      const hunks = f.status === 'A' ? null : changedHunks(git('diff', '-U0', `${c.sha}^`, c.sha, '--', f.path));
      for (const t of touchedTests(testsIn(git('show', `${c.sha}:${f.path}`)), hunks)) keys.add(`${f.path}\0${t.title}`);
    }
  }
  return keys;
}

function context() {
  const ref = process.env['RECEIPT_BASE'] || 'origin/master';
  const base = git('merge-base', ref, 'HEAD');
  const changes = classify(git('diff', '--name-status', '--no-renames', base, 'HEAD'));
  const list = commits(git('log', '--no-merges', '--format=%x1e%H%x1f%s%x1f%b', `${base}..HEAD`));
  // With a problem report, the old app is the one right before its first fix: what a "Regression test:" commit pushed alone
  // would have run against, hooks it added included.
  const firstFix = list.findLast((c) => c.subject.startsWith(PROBLEM));
  const old = firstFix ? git('rev-parse', `${firstFix.sha}^`) : base;
  changes.app = classify(git('diff', '--name-status', '--no-renames', old, 'HEAD')).app;
  const where = firstFix ? `, right before "${firstFix.subject}"` : ref === 'origin/master' ? ', where the branch started' : `, the merge base with ${ref}`;
  return { base, old, label: `\`${old.slice(0, 7)}\`${where}`, changes, problems: problemReports(list), keys: regressionKeys(list) };
}

function lines(base, { status, path }) {
  return status === 'A' ? null : changedHunks(git('diff', '-U0', base, 'HEAD', '--', path));
}

function plan() {
  const { changes, problems, keys } = context();
  const tests = changes.unit.length + changes.e2e.length;
  const run = changes.app.length > 0 && tests > 0;
  if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `run=${run}\ne2e=${run && changes.e2e.length > 0}\n`);
  if (run) return console.log(`${changes.unit.length} unit test files and ${changes.e2e.length} browser test files to run against the old app`);
  const why = !tests ? 'This branch adds or changes no tests under `test/` or `e2e/`.' : 'This branch changes only tests and tooling, so its tests have no older app to run against.';
  // Tests changed without the app: there is no old code to run them on, so they neither prove nor disprove a fix.
  const result = verdict({ problems, results: [], regressions: keys.size, incomplete: tests > 0 });
  report(summary({ problems, results: [], notes: [], outcome: result, intro: `Nothing to run. ${why}` }));
  if (result.fail) process.exitCode = 1;
}

function runUnit(base, files, keys) {
  const out = '/tmp/receipt-vitest.json';
  rmSync(out, { force: true });
  spawnSync('pnpm', ['exec', 'vitest', 'run', '--includeTaskLocation', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...files.map((f) => f.path)], { stdio: 'inherit', timeout: 8 * 60_000 });
  if (!existsSync(out)) return { results: [], incomplete: true, note: 'The unit tests could not run on the old code (vitest wrote no report in 8 minutes; see the job log).' };
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const results = [];
  for (const f of files) {
    const file = json.testResults.find((r) => relative(process.cwd(), r.name) === f.path);
    const inFile = [...keys].some((k) => k.startsWith(`${f.path}\0`));
    if (!file) { results.push({ where: f.path, title: '', status: 'missing', regression: inFile }); continue; }
    if (!file.assertionResults.length && file.status === 'failed') {
      // A file that does not load on the old code shows nothing about the bug, only that it imports something new.
      results.push({ where: f.path, title: '', status: 'missing', note: 'the file does not load on the old code', regression: inFile });
      continue;
    }
    const tests = file.assertionResults.map((t) => ({ line: t.location?.line ?? 0, name: t.title, title: t.fullName, status: outcome(t.status === 'pending' || t.status === 'todo' ? 'skipped' : t.status, t.failureMessages) }));
    for (const t of touchedTests(tests, lines(base, f))) results.push({ where: `${f.path}:${t.line}`, title: t.title, status: t.status, regression: keys.has(`${f.path}\0${t.name}`) });
  }
  return { results, incomplete: false };
}

/** Every spec of a Playwright JSON report, with the file relative to the repository. */
function specs(json) {
  const all = [];
  const walk = (suite) => { for (const s of suite.specs ?? []) all.push({ ...s, path: `e2e/${s.file}` }); for (const c of suite.suites ?? []) walk(c); };
  for (const s of json.suites ?? []) walk(s);
  return all;
}

function playwright(args, out, minutes) {
  rmSync(out, { force: true });
  spawnSync('pnpm', ['exec', 'playwright', 'test', '--project=chromium', ...args], { stdio: 'inherit', timeout: minutes * 60_000, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out } });
  return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
}

/** A browser test's outcome from its last result. Interrupted (the global timeout) means it did not finish: missing. */
export function browserOutcome(test) {
  const last = test?.results?.at(-1);
  if (!last) return 'missing';
  const messages = [last.error?.message, ...(last.errors ?? []).map((e) => e.message)].filter(Boolean);
  if (last.status === 'failed' || last.status === 'timedOut') return outcome('failed', messages);
  if (last.status === 'passed' || last.status === 'skipped') return last.status;
  return 'missing';
}

function runE2e(base, files, keys) {
  const listed = playwright(['--list', '--reporter=json', ...files.map((f) => f.path)], '/tmp/receipt-e2e-list.json', 3);
  if (!listed) return { results: [], incomplete: true, note: 'The browser tests could not be listed (see the job log).' };
  const all = specs(listed);
  const picked = files.flatMap((f) => touchedTests(all.filter((s) => s.path === f.path), lines(base, f)));
  if (!picked.length) return { results: [], incomplete: false };
  // No retries: a test that fails once on the old code has failed there. The global timeout (15 min) ends the run in time
  // to report inside the step's own limit; tests it cuts off count as not run.
  const ran = playwright(['--retries=0', '--global-timeout=900000', '--reporter=list,json', ...picked.map((s) => `${s.path}:${s.line}`)], '/tmp/receipt-e2e.json', 20);
  const done = ran ? specs(ran) : [];
  const results = picked.map((s) => {
    const test = done.find((d) => d.id === s.id)?.tests.find((t) => t.projectName === 'chromium');
    return { where: `${s.path}:${s.line}`, title: s.title, status: browserOutcome(test), regression: keys.has(`${s.path}\0${s.title}`) };
  });
  return { results, incomplete: false, note: ran ? undefined : 'The browser tests could not run on the old code (see the job log).' };
}

/** Puts the merge base's version of each changed app file in place; the index keeps the branch's. */
function oldApp(base, files) {
  for (const f of files) {
    rmSync(f.path, { recursive: true, force: true });
    if (f.status === 'A') continue;
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, execFileSync('git', ['show', `${base}:${f.path}`], { maxBuffer: 64 << 20 }));
  }
}

/** Brings the branch's app files back from the index. */
function branchApp(files) {
  for (const f of files) rmSync(f.path, { recursive: true, force: true });
  const kept = files.filter((f) => f.status !== 'D').map((f) => f.path);
  if (kept.length) git('checkout', '--', ...kept);
}

function run() {
  const { base, old, label, changes, problems, keys } = context();
  if (changes.app.length && git('status', '--porcelain', '--', ...changes.app.map((f) => f.path))) throw new Error('the app files have local changes; the receipt swaps them and would lose them');
  const parts = [];
  oldApp(old, changes.app);
  try {
    if (changes.unit.length) parts.push(runUnit(base, changes.unit, keys));
    if (changes.e2e.length) parts.push(runE2e(base, changes.e2e, keys));
  } finally {
    branchApp(changes.app);
  }
  const results = parts.flatMap((p) => p.results);
  const result = verdict({ problems, results, regressions: keys.size, incomplete: parts.some((p) => p.incomplete) });
  const names = changes.app.map((f) => `\`${f.path}\``);
  const reverted = `Put back for the run: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` and ${names.length - 12} more` : ''}.`;
  report(summary({ base: label, problems, results, notes: [reverted, ...parts.map((p) => p.note).filter(Boolean)], outcome: result }));
  if (result.fail) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'plan') plan();
  else if (command === 'run') run();
  else { console.error('usage: node scripts/red-green.mjs plan|run'); process.exit(2); }
}
