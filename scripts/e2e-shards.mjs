#!/usr/bin/env node
/**
 * One shard's tests of the browser suite, as a Playwright --test-list (e2e.yml):
 *
 *   node scripts/e2e-shards.mjs <project> <shard> <shards> <file>
 *
 * The tests are dealt out like cards: in file order, every <shards>th one to a shard. Playwright's own --shard cuts the
 * same list into runs of equal count instead, and the slow tests sit together in a few files (attachment.spec.ts,
 * resilience.spec.ts), so they landed on one shard and the gate to master waited for it: on 2026-11-15 the tests of one
 * Chromium shard took 336 s and those of another 118 s. Dealt out, each file is spread over all the shards (about 260 s
 * for the slowest on the times of that day), with no times to keep: a split by each test's measured time came to 200 s,
 * but only as long as somebody kept the times up to date.
 *
 * The suite is listed with this environment, so against a deployed copy (E2E_URL) without the @local tests. Every shard
 * works out its own share on its own runner, from the same commit and so the same list.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/** The tests of one project as Playwright lists them here, through a test list when one is given: where, and under what name. */
function listed(project, testList) {
  const args = ['exec', 'playwright', 'test', '--list', '--reporter=json', `--project=${project}`, ...(testList ? ['--test-list', testList] : [])];
  const report = JSON.parse(execFileSync('pnpm', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'inherit'] }));
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      if (spec.tests?.some((t) => t.projectName === project)) tests.push({ file: spec.file, line: spec.line, column: spec.column, id: [spec.file, ...titles, spec.title].join(' › ') });
    }
    // The file's own suite is titled with the file's name; describe blocks below it add theirs, an anonymous one none (as
    // in Playwright's own title path, which a test list is matched against).
    for (const s of suite.suites ?? []) walk(s, s.title ? [...titles, s.title] : titles);
  };
  for (const file of report.suites ?? []) walk(file, []);
  return tests;
}

const [project, shard, shards, file] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];
try {
  if (!project || !Number.isInteger(shards) || !(Number.isInteger(shard) && shard >= 1 && shard <= shards) || !file) throw new Error('usage: e2e-shards.mjs <project> <shard> <shards> <file>');
  // In the order of the files and of the tests in them, whatever order the report has them in: every runner must deal alike.
  const tests = listed(project).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  if (!tests.length) throw new Error(`playwright listed no tests of ${project}`);
  const mine = tests.filter((_, i) => i % shards === shard - 1).map((t) => t.id);
  writeFileSync(file, mine.map((id) => `[${project}] › ${id}\n`).join(''));
  // What Playwright takes from the list must be this shard's tests, no fewer and no more. A test that no line can name (a
  // newline or a › in its title, a test defined in a helper file) would run on no shard, and a line that matches more than
  // its test (a describe titled like a test beside it, two tests of one name) on two. Every shard checks its own share,
  // so together they run the suite once.
  const got = mine.length ? listed(project, file).map((t) => t.id) : [];
  const missed = mine.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !mine.includes(id));
  if (missed.length || extra.length || got.length !== mine.length) {
    const what = [missed.length && `it misses ${missed.join('; ')}`, extra.length && `it also takes ${extra.join('; ')}`, got.length !== mine.length && `${got.length} tests for ${mine.length} lines`].filter(Boolean).join(', and ');
    throw new Error(`the test list of ${project} shard ${shard} does not select its own tests: ${what}`);
  }
  console.log(`${project} shard ${shard}/${shards}: ${mine.length} of ${tests.length} tests`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
