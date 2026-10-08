// The red-then-green receipt (.github/workflows/receipt.yml). A regression test proves it covers a bug only if it fails
// without the fix. This runs the tests a branch adds or changes against src/ as it was before the branch, and says per test
// whether it fails there.
//
//   node scripts/receipt.mjs plan   whether there is anything to run; writes run= and e2e= to $GITHUB_OUTPUT
//   node scripts/receipt.mjs run    puts the old src/ in place, runs the touched tests, puts src/ back, reports
//
// "Before the branch" is the merge base with RECEIPT_BASE (default origin/master). Only src/ goes back in time: the tests,
// their helpers, the configs and the dependencies stay as the branch has them.
//
// Which tests a branch touched: those whose lines the diff changes (touchedTests has the rules). A changed file where no
// test's lines changed (a helper or an import at the top) counts with all its tests. Unit test
// files run whole (they are fast) and only the touched tests are reported; browser tests run by file:line in Chromium only.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { relative } from 'node:path';

export const GOOD = 'fails without the change (good: it covers it)';
export const WEAK = 'passes without the change';
const PROBLEM = 'Problem report:';

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

/** What the branch changed that matters here, from `git diff --name-status --no-renames`. */
export function classify(nameStatus) {
  const files = nameStatus.split('\n').filter(Boolean).map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
  const kept = files.filter((f) => f.status !== 'D');
  return {
    src: files.some((f) => f.path.startsWith('src/')),
    unit: kept.filter((f) => /^test\/.*\.test\.ts$/.test(f.path)),
    e2e: kept.filter((f) => /^e2e\/.*\.spec\.ts$/.test(f.path)),
  };
}

/**
 * The job's verdict. It fails only when the branch fixes a problem report and every touched test ran and passed on the old
 * code: nothing then shows the tests cover the bug. A part that could not run leaves it informative.
 */
export function verdict({ problems, results, incomplete }) {
  const caught = results.some((r) => r.status === 'failed');
  if (problems.length && !caught && !incomplete) return { fail: true, text: `This branch fixes a problem report, but none of its tests fails without the change, so nothing shows they cover the bug. A regression test should fail on the old code first (CLAUDE.md: bug fixes start red).` };
  if (caught) return { fail: false, text: `At least one test fails without the change: the branch carries its red-then-green receipt.` };
  if (problems.length) return { fail: false, text: `No test failed without the change, but not every test could run, so this stays informative.` };
  return { fail: false, text: `No test fails without the change. That is fine for a feature or a refactor; a bug fix should have one that does.` };
}

const words = { failed: GOOD, passed: WEAK, skipped: 'skipped on the old code', missing: 'did not run' };

export function summary({ base, problems, results, notes, outcome }) {
  const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const out = ['## Red-then-green receipt', '', `The tests this branch adds or changes, run against \`src/\` from ${base}, where the branch started.`, ''];
  if (problems.length) out.push(`Problem report fixes on this branch: ${problems.map((p) => `"${p}"`).join(', ')}.`, '');
  if (results.length) {
    out.push('| Test | Without the change |', '|---|---|');
    for (const r of results) out.push(`| ${cell(r.where)} ${cell(r.title)} | ${cell(words[r.status] + (r.note ? ` (${r.note})` : ''))} |`);
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

function context() {
  const ref = process.env['RECEIPT_BASE'] || 'origin/master';
  const base = git('merge-base', ref, 'HEAD');
  const changes = classify(git('diff', '--name-status', '--no-renames', base, 'HEAD'));
  const problems = git('log', '--no-merges', '--format=%s', `${base}..HEAD`).split('\n').filter((s) => s.startsWith(PROBLEM));
  const label = `\`${base.slice(0, 7)}\`${ref === 'origin/master' ? '' : ` (merge base with ${ref})`}`;
  return { base, label, changes, problems };
}

function lines(base, { status, path }) {
  return status === 'A' ? null : changedHunks(git('diff', '-U0', base, 'HEAD', '--', path));
}

function plan() {
  const { changes, problems } = context();
  const tests = changes.unit.length + changes.e2e.length;
  const run = changes.src && tests > 0;
  if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `run=${run}\ne2e=${run && changes.e2e.length > 0}\n`);
  if (run) return console.log(`${changes.unit.length} unit test files and ${changes.e2e.length} browser test files to run against the old src/`);
  const why = !changes.src ? 'This branch does not change `src/`, so its tests have no older code to run against.' : 'This branch changes `src/` but adds or changes no tests under `test/` or `e2e/`.';
  report(`## Red-then-green receipt\n\nNothing to run. ${why}\n`);
  if (problems.length && !tests) console.log(`::warning::This branch fixes a problem report (${problems[0]}) without a changed test, so nothing shows the bug is covered.`);
}

function runUnit(base, files) {
  const out = '/tmp/receipt-vitest.json';
  rmSync(out, { force: true });
  spawnSync('pnpm', ['exec', 'vitest', 'run', '--includeTaskLocation', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...files.map((f) => f.path)], { stdio: 'inherit', timeout: 15 * 60_000 });
  if (!existsSync(out)) return { results: [], incomplete: true, note: 'The unit tests could not run on the old code (vitest wrote no report; see the job log).' };
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const results = [];
  for (const f of files) {
    const file = json.testResults.find((r) => relative(process.cwd(), r.name) === f.path);
    if (!file) { results.push({ where: f.path, title: '', status: 'missing' }); continue; }
    if (!file.assertionResults.length && file.status === 'failed') {
      // A file that does not even load on the old code fails without the change too, if less tellingly.
      results.push({ where: f.path, title: '', status: 'failed', note: 'the file does not load' });
      continue;
    }
    const tests = file.assertionResults.map((t) => ({ line: t.location?.line ?? 0, title: t.fullName, status: t.status === 'pending' || t.status === 'todo' ? 'skipped' : t.status }));
    for (const t of touchedTests(tests, lines(base, f))) results.push({ where: `${f.path}:${t.line}`, title: t.title, status: t.status });
  }
  return { results, incomplete: results.some((r) => r.status === 'missing') };
}

/** Every spec of a Playwright JSON report, with the file relative to the repository. */
function specs(json) {
  const all = [];
  const walk = (suite) => { for (const s of suite.specs ?? []) all.push({ ...s, path: `e2e/${s.file}` }); for (const c of suite.suites ?? []) walk(c); };
  for (const s of json.suites ?? []) walk(s);
  return all;
}

function playwright(args, out) {
  rmSync(out, { force: true });
  spawnSync('pnpm', ['exec', 'playwright', 'test', '--project=chromium', ...args], { stdio: 'inherit', timeout: 30 * 60_000, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out } });
  return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
}

function runE2e(base, files) {
  const listed = playwright(['--list', '--reporter=json', ...files.map((f) => f.path)], '/tmp/receipt-e2e-list.json');
  if (!listed) return { results: [], incomplete: true, note: 'The browser tests could not be listed (see the job log).' };
  const all = specs(listed);
  const picked = files.flatMap((f) => touchedTests(all.filter((s) => s.path === f.path), lines(base, f)));
  if (!picked.length) return { results: [], incomplete: false };
  // No retries: a test that fails once on the old code has failed there. The global timeout leaves time to write the report.
  const ran = playwright(['--retries=0', '--global-timeout=1500000', '--reporter=list,json', ...picked.map((s) => `${s.path}:${s.line}`)], '/tmp/receipt-e2e.json');
  const done = ran ? specs(ran) : [];
  const results = picked.map((s) => {
    const test = done.find((d) => d.id === s.id)?.tests.find((t) => t.projectName === 'chromium');
    const status = !test || !test.results.length ? 'missing' : test.status === 'unexpected' ? 'failed' : test.status === 'skipped' ? 'skipped' : 'passed';
    return { where: `${s.path}:${s.line}`, title: s.title, status };
  });
  return { results, incomplete: results.some((r) => r.status === 'missing'), note: ran ? undefined : 'The browser tests could not run on the old code (see the job log).' };
}

function run() {
  const { base, label, changes, problems } = context();
  if (git('status', '--porcelain', '--', 'src')) throw new Error('src/ has local changes; the receipt swaps src/ and would lose them');
  const parts = [];
  // The old src/ goes in from the commit itself, so the index keeps the branch's and `git checkout -- src` brings it back.
  rmSync('src', { recursive: true, force: true });
  execSync(`git archive ${base} src | tar -x`);
  try {
    if (changes.unit.length) parts.push(runUnit(base, changes.unit));
    if (changes.e2e.length) parts.push(runE2e(base, changes.e2e));
  } finally {
    rmSync('src', { recursive: true, force: true });
    git('checkout', '--', 'src');
  }
  const results = parts.flatMap((p) => p.results);
  const incomplete = parts.some((p) => p.incomplete);
  const outcome = verdict({ problems, results, incomplete });
  report(summary({ base: label, problems, results, notes: parts.map((p) => p.note).filter(Boolean), outcome }));
  if (outcome.fail) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'plan') plan();
  else if (command === 'run') run();
  else { console.error('usage: node scripts/receipt.mjs plan|run'); process.exit(2); }
}
