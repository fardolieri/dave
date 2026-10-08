// The decisions of scripts/receipt.mjs, without git or test runners: node --test scripts/receipt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedHunks, classify, GOOD, problemReports, summary, touchedTests, verdict } from './receipt.mjs';

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

test('only kept unit and browser test files count; any src change counts', () => {
  const c = classify(['M\tsrc/client/call.ts', 'M\te2e/share.spec.ts', 'M\te2e/fixtures.ts', 'A\ttest/new.test.ts', 'D\ttest/old.test.ts', 'M\ttest/harness.ts'].join('\n'));
  assert.equal(c.src, true);
  assert.deepEqual(c.e2e.map((f) => f.path), ['e2e/share.spec.ts']);
  assert.deepEqual(c.unit.map((f) => f.path), ['test/new.test.ts']);
  assert.equal(classify('M\te2e/share.spec.ts').src, false);
});

test('the job fails only for a problem report whose tests all ran and all passed on the old code', () => {
  const problems = [{ subject: 'Problem report: x' }];
  const passed = [{ status: 'passed' }];
  assert.equal(verdict({ problems, results: passed, incomplete: false }).fail, true);
  assert.equal(verdict({ problems, results: [...passed, { status: 'failed' }], incomplete: false }).fail, false);
  assert.equal(verdict({ problems, results: passed, incomplete: true }).fail, false);
  assert.equal(verdict({ problems: [], results: passed, incomplete: false }).fail, false);
});

test('a problem report with no changed test fails, unless its body says why there is none', () => {
  const log = (body) => `\x1eRegression test: x\x1f\n\x1eProblem report: x\x1f${body}\n`;
  const bare = problemReports(log('Fixed the thing.\n\nCo-Authored-By: someone'));
  assert.deepEqual(bare, [{ subject: 'Problem report: x', excuse: undefined }]);
  assert.equal(verdict({ problems: bare, results: [], incomplete: false, tested: false }).fail, true);

  const excused = problemReports(log('Fixed the thing.\n\nNo regression test: only a real iPhone shows it\n'));
  assert.deepEqual(excused, [{ subject: 'Problem report: x', excuse: 'only a real iPhone shows it' }]);
  const outcome = verdict({ problems: excused, results: [], incomplete: false, tested: false });
  assert.equal(outcome.fail, false);
  assert.match(summary({ problems: excused, results: [], notes: [], outcome, intro: 'Nothing to run.' }), /without a regression test because: "only a real iPhone shows it"/);

  assert.equal(verdict({ problems: [], results: [], incomplete: false, tested: false }).fail, false);
  // A reason is required, on the same line.
  assert.deepEqual(problemReports(log('No regression test:\nCo-Authored-By: someone')), [{ subject: 'Problem report: x', excuse: undefined }]);
});

test('the summary names each test with its outcome in plain words', () => {
  const results = [{ where: 'e2e/share.spec.ts:33', title: 'a | b', status: 'failed' }];
  const text = summary({ base: '`abc1234`', problems: [], results, notes: [], outcome: verdict({ problems: [], results, incomplete: false }) });
  assert.match(text, new RegExp(`\\| e2e/share.spec.ts:33 a \\\\\\| b \\| ${GOOD.replace(/[()]/g, '\\$&')} \\|`));
});
