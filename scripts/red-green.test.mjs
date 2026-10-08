// The decisions of scripts/red-green.mjs, without git or test runners: node --test scripts/red-green.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserOutcome, carriesRegression, changedHunks, classify, commits, GOOD, outcome, problemReports, summary, testsIn, touchedTests, verdict } from './red-green.mjs';

test('changed hunks come from the new side of the diff; a deletion marks both lines around the gap', () => {
  const diff = ['diff --git a/x b/x', '@@ -31,7 +31,7 @@ test(', '-a', '+b', '@@ -40 +40,3 @@', '@@ -60,2 +62,0 @@', '@@ -70 +72 @@'].join('\n');
  assert.deepEqual(changedHunks(diff), [[31, 37], [40, 42], [62, 63], [72, 72]]);
});

test('a change inside a test touches it, a test reaching up to the next one', () => {
  const tests = [{ line: 15 }, { line: 33 }, { line: 49 }];
  assert.deepEqual(touchedTests(tests, [[34, 35]]), [{ line: 33 }]);
  assert.deepEqual(touchedTests(tests, [[48, 48]]), [{ line: 33 }]);
  assert.deepEqual(touchedTests(tests, [[500, 500]]), [{ line: 49 }]);
  assert.deepEqual(touchedTests(tests, [[16, 16], [50, 51]]), [{ line: 15 }, { line: 49 }]);
});

test('a test added after another touches only the new one', () => {
  // ticket 39 in test/cue.test.ts: a blank line and a describe, then the new test, after the test at line 80
  assert.deepEqual(touchedTests([{ line: 80 }, { line: 96 }], [[94, 104]]), [{ line: 96 }]);
});

test('a new file, or a change outside every test, counts all the tests of the file', () => {
  const tests = [{ line: 15 }, { line: 33 }];
  assert.deepEqual(touchedTests(tests, null), tests);
  assert.deepEqual(touchedTests(tests, [[2, 3]]), tests);
});

test('tests are read from source with their line and literal title', () => {
  const source = ["import { test } from './fixtures';", '', "test('a share flows', async () => {", '});', "  it(\"plays the friend's cue\", () => {});", "test.skip('ticket 23: each friend\\'s picture', async () => {});"].join('\n');
  assert.deepEqual(testsIn(source), [{ line: 3, title: 'a share flows' }, { line: 5, title: "plays the friend's cue" }, { line: 6, title: "ticket 23: each friend's picture" }]);
});

test('every app file goes back, the test side stays; only kept test files run', () => {
  const c = classify(['M\tsrc/client/call.ts', 'M\tindex.html', 'A\tpublic/x.png', 'M\twrangler.jsonc', 'M\tvite.config.ts', 'M\te2e/share.spec.ts', 'M\te2e/fixtures.ts',
    'A\ttest/new.test.ts', 'D\ttest/old.test.ts', 'M\ttest/harness.ts', 'M\tpackage.json', 'M\tpnpm-lock.yaml', 'M\tplaywright.config.ts', 'M\tscripts/red-green.mjs', 'M\tREADME.md', 'M\t.github/workflows/ci.yml'].join('\n'));
  assert.deepEqual(c.app.map((f) => f.path), ['src/client/call.ts', 'index.html', 'public/x.png', 'wrangler.jsonc', 'vite.config.ts']);
  assert.deepEqual(c.e2e.map((f) => f.path), ['e2e/share.spec.ts']);
  assert.deepEqual(c.unit.map((f) => f.path), ['test/new.test.ts']);
  assert.deepEqual(classify('M\te2e/share.spec.ts\nM\tCLAUDE.md').app, []);
});

test('a failure on code the branch adds is inconclusive, not a receipt', () => {
  assert.equal(outcome('failed', ['TypeError: shareCue is not a function']), 'inconclusive');
  assert.equal(outcome('failed', ["SyntaxError: The requested module '../src/core/cue' does not provide an export named 'shareCue'"]), 'inconclusive');
  assert.equal(outcome('failed', ['Error: expect(locator).toHaveClass(expected) failed']), 'failed');
  assert.equal(outcome('passed'), 'passed');
  assert.equal(outcome('skipped'), 'skipped');
});

test('a browser test cut off by the global timeout did not run; one that timed out on its own failed', () => {
  assert.equal(browserOutcome({ results: [{ status: 'interrupted' }] }), 'missing');
  assert.equal(browserOutcome({ results: [] }), 'missing');
  assert.equal(browserOutcome(undefined), 'missing');
  assert.equal(browserOutcome({ results: [{ status: 'timedOut', errors: [{ message: 'Test timeout of 120000ms exceeded.' }] }] }), 'failed');
  assert.equal(browserOutcome({ results: [{ status: 'failed', error: { message: "TypeError: __dave[n] is not a function" } }] }), 'inconclusive');
  assert.equal(browserOutcome({ results: [{ status: 'skipped' }] }), 'skipped');
});

const fix = [{ subject: 'Problem report: x' }];

test('a problem report fails when its regression tests all ran and all passed on the old code', () => {
  const passed = { status: 'passed', regression: true };
  assert.equal(verdict({ problems: fix, results: [passed], regressions: 1 }).fail, true);
  assert.equal(verdict({ problems: fix, results: [passed, { status: 'failed', regression: true }], regressions: 2 }).fail, false);
  assert.equal(verdict({ problems: fix, results: [passed], regressions: 1, incomplete: true }).fail, false);
  assert.equal(verdict({ problems: [], results: [{ status: 'passed' }], regressions: 0 }).fail, false);
});

test('only the regression tests count: a feature test failing on the old code is no receipt', () => {
  const results = [{ status: 'passed', regression: true }, { status: 'failed', regression: false }];
  assert.equal(verdict({ problems: fix, results, regressions: 1 }).fail, true);
});

test('a regression test that skipped, did not run or was inconclusive leaves it informative, neither red nor green', () => {
  for (const status of ['skipped', 'missing', 'inconclusive']) {
    const result = verdict({ problems: fix, results: [{ status, regression: true }], regressions: 1 });
    assert.equal(result.fail, false, status);
    assert.match(result.text, /informative/, status);
  }
});

test('a problem report with no regression test fails, unless its body says why there is none', () => {
  const log = (body) => `\x1eabc\x1fRegression test: x\x1f\n\x1edef\x1fProblem report: x\x1f${body}\n`;
  const list = commits(log('Fixed the thing.\n\nCo-Authored-By: someone'));
  assert.deepEqual(list.map(carriesRegression), [true, true]);
  const bare = problemReports(list);
  assert.deepEqual(bare, [{ subject: 'Problem report: x', excuse: undefined }]);
  assert.equal(verdict({ problems: bare, results: [], regressions: 0 }).fail, true);
  // Tests changed in other commits do not stand in for a regression test.
  assert.equal(verdict({ problems: bare, results: [{ status: 'failed', regression: false }], regressions: 0 }).fail, true);

  const excused = problemReports(commits(log('Fixed the thing.\n\nNo regression test: only a real iPhone shows it\n')));
  assert.deepEqual(excused, [{ subject: 'Problem report: x', excuse: 'only a real iPhone shows it' }]);
  const result = verdict({ problems: excused, results: [], regressions: 0 });
  assert.equal(result.fail, false);
  assert.match(summary({ problems: excused, results: [], notes: [], outcome: result, intro: 'Nothing to run.' }), /without a regression test because: "only a real iPhone shows it"/);

  assert.equal(verdict({ problems: [], results: [], regressions: 0 }).fail, false);
  // A reason is required, on the same line.
  assert.deepEqual(problemReports(commits(log('No regression test:\nCo-Authored-By: someone'))), [{ subject: 'Problem report: x', excuse: undefined }]);
});

test('the summary names each test with its outcome in plain words', () => {
  const results = [{ where: 'e2e/share.spec.ts:33', title: 'a | b', status: 'failed', regression: true }];
  const text = summary({ base: '`abc1234`', problems: fix, results, notes: [], outcome: verdict({ problems: fix, results, regressions: 1 }) });
  assert.match(text, new RegExp(`\\| e2e/share.spec.ts:33 a \\\\\\| b \\| yes \\| ${GOOD.replace(/[()]/g, '\\$&')} \\|`));
});
