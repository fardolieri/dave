#!/usr/bin/env node
/**
 * The flake ledger: every e2e try that failed, from every run (branches, previews, nightly), kept on the `flake-ledger`
 * branch and counted by test and error, so a flake is one row with its sightings instead of a ticket per sighting.
 *
 *   node scripts/flakes/ledger.mjs outcomes <Playwright JSON report>      one JSON line per test that failed a try, and one
 *                                                                          for the shard; run details from the environment
 *   node scripts/flakes/ledger.mjs add <ledger dir> <outcome files...>     appends them to ledger.jsonl, writes README.md
 *                                                                          and top.txt
 *
 * `outcomes` runs in each e2e shard (e2e.yml), `add` after the run (flakes.yml). A row's ticket comes from causes.json on
 * the ledger branch: `[{ "match": "<regex over the row's test and error>", "ticket": "61" }]`, edited by hand.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAYS = 30;
/** Lines older than this are dropped from ledger.jsonl as it is written. */
const KEEP_DAYS = 90;
const repo = process.env.GITHUB_REPOSITORY ?? 'fardolieri/dave';

/** An error's first line, and for the console check the first problem it names: what tells one flake from another. */
function errorLine(message = '') {
  const lines = message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = (lines[0] ?? 'no error message').replace(/^Error:\s*/, '');
  if (!/nobody expected/.test(first)) return first;
  const problem = lines.find((l) => /^\+\s+"/.test(l));
  return problem ? `${first}: ${problem.replace(/^\+\s+"|",?$/g, '')}` : first;
}

/** Ids, numbers, addresses and times out, so the same failure on another run reads the same. */
export function normalize(line) {
  return line
    .replace(/\b(?:wss?|https?):\/\/[^\s'"]+/g, '<url>')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b/g, '<id>')
    .replace(/\d+(?:\.\d+)?/g, 'N')
    .slice(0, 300);
}

function targetOf(url = '') {
  if (!url) return 'branch';
  if (url === 'nightly' || url.includes('dave-nightly')) return 'nightly';
  if (url.includes('dave-pr-')) return 'preview';
  return 'other';
}

function outcomes(reportPath) {
  if (!existsSync(reportPath)) return;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const env = process.env;
  const run = {
    run: Number(env.RUN_ID), attempt: Number(env.RUN_ATTEMPT), sha: env.SHA, ref: env.REF, event: env.EVENT,
    // A run hunting a flake (e2e.yml by hand, with -g or --repeat-each) repeats one test on purpose.
    hunt: !!env.GREP || (!!env.REPEAT && env.REPEAT !== '1'), target: targetOf(env.E2E_URL),
    project: env.PROJECT, shard: Number(env.SHARD), at: new Date().toISOString(),
  };
  let tests = 0;
  const out = [];
  const walk = (suite, path) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status === 'skipped') continue;
        tests++;
        const failedTry = (t.results ?? []).find((r) => r.status !== 'passed' && r.status !== 'skipped');
        if (!failedTry) continue;
        const error = errorLine(failedTry.error?.message ?? failedTry.errors?.[0]?.message);
        out.push({
          ...run, kind: t.status === 'flaky' ? 'flaky' : 'failed', file: spec.file, line: spec.line,
          test: [...path, spec.title].join(' › '), error, signature: normalize(error),
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s, s.title && !s.title.endsWith('.ts') ? [...path, s.title] : path);
  };
  for (const s of report.suites ?? []) walk(s, []);
  for (const o of out) console.log(JSON.stringify(o));
  console.log(JSON.stringify({ ...run, kind: 'shard', tests }));
}

function add(dir, files) {
  const ledgerPath = join(dir, 'ledger.jsonl');
  const old = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const seen = new Set(old.filter((o) => o.kind === 'shard').map((o) => `${o.run}/${o.attempt}/${o.project}/${o.shard}`));
  const fresh = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((o) => !seen.has(`${o.run}/${o.attempt}/${o.project}/${o.shard}`));
  const keepFrom = Date.now() - KEEP_DAYS * 86_400_000;
  const all = [...old, ...fresh].filter((o) => Date.parse(o.at) >= keepFrom);
  writeFileSync(ledgerPath, all.map((o) => JSON.stringify(o)).join('\n') + (all.length ? '\n' : ''));
  summarize(dir, all);
  console.log(`${fresh.filter((o) => o.kind !== 'shard').length} failed tries added, ${fresh.filter((o) => o.kind === 'shard').length} shards`);
}

function summarize(dir, all) {
  const since = Date.now() - DAYS * 86_400_000;
  // A run hunting a flake would count its repeats as sightings: kept, not counted.
  const recent = all.filter((o) => Date.parse(o.at) >= since && !o.hunt);
  // causes.json is edited by hand: a mistake in it shows in the README and stops nothing.
  const warnings = [];
  let causes = [];
  const causesPath = join(dir, 'causes.json');
  try { if (existsSync(causesPath)) causes = JSON.parse(readFileSync(causesPath, 'utf8')); } catch (e) { warnings.push(`causes.json is not read: ${e.message}`); }
  causes = (Array.isArray(causes) ? causes : []).flatMap((c) => {
    try { return [{ re: new RegExp(c.match), ticket: String(c.ticket ?? '') }]; } catch (e) { warnings.push(`causes.json, ticket ${c?.ticket}: ${e.message}`); return []; }
  });
  const runs = {};
  for (const o of recent.filter((o) => o.kind === 'shard')) (runs[o.target] ??= new Set()).add(`${o.run}/${o.attempt}`);
  // On a branch or its preview a test failing both tries is mostly the branch's own bug: only flaky tries count there.
  // Against nightly, master's code that already passed its branch's runs, a failed test counts too.
  const counted = recent.filter((o) => o.kind === 'flaky' || (o.kind === 'failed' && o.target === 'nightly'));
  const week = Date.now() - 7 * 86_400_000;
  const rows = new Map();
  for (const o of counted) {
    const key = `${o.file} › ${o.test} | ${o.signature}`;
    const row = rows.get(key) ?? { key, file: o.file, test: o.test, error: o.error, n: 0, week: 0, flaky: 0, where: {}, first: o, last: o };
    row.n++;
    if (Date.parse(o.at) >= week) row.week++;
    if (o.kind === 'flaky') row.flaky++;
    row.where[o.target] = (row.where[o.target] ?? 0) + 1;
    if (o.at < row.first.at) row.first = o;
    if (o.at > row.last.at) { row.last = o; row.error = o.error; }
    rows.set(key, row);
  }
  for (const row of rows.values()) row.ticket = causes.find((c) => c.re.test(row.key))?.ticket ?? '';
  const sorted = [...rows.values()].sort((a, b) => b.n - a.n || b.last.at.localeCompare(a.last.at));
  const link = (o) => `[${o.at.slice(5, 10)}](https://github.com/${repo}/actions/runs/${o.run}/attempts/${o.attempt})`;
  const cell = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    '# Flake ledger',
    '',
    `Every e2e try that failed in the last ${DAYS} days, by test and error, newest data ${new Date().toISOString().slice(0, 16)} UTC.`,
    'Written by `flakes.yml` after each e2e and preview run (`scripts/flakes/ledger.mjs` on master). A flaky try failed and',
    'passed on its retry; against nightly a test that failed both tries counts too, on branches and previews only flaky',
    'ones do (failing twice there is mostly the branch\'s own bug). Runs hunting a flake (-g, --repeat-each) are kept but not counted. The ticket',
    'column comes from `causes.json` here: one ticket per cause, its rows matched by a regex over "file › test | error".',
    '',
    ...warnings.map((w) => `**Warning:** ${cell(w)}`),
    ...(warnings.length ? [''] : []),
    `Runs recorded: ${Object.entries(runs).map(([t, s]) => `${t} ${s.size}`).join(', ') || 'none yet'}.`,
    '',
    '| Seen | Flaky | Where | Test | Error | First | Last | Ticket |',
    '|---:|---:|---|---|---|---|---|---|',
    ...sorted.map((r) => `| ${r.n} | ${r.flaky} | ${Object.entries(r.where).map(([t, n]) => `${t} ${n}`).join(', ')} | ${cell(`${r.file} › ${r.test}`)} | ${cell(r.error.slice(0, 160))} | ${link(r.first)} | ${link(r.last)} | ${r.ticket} |`),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'README.md'), md);
  // For the session briefing: the three rows seen most in the last week.
  const top = sorted.filter((r) => r.week > 0).sort((a, b) => b.week - a.week || b.n - a.n).slice(0, 3)
    .map((r) => `${r.week}x this week (${r.n}x in ${DAYS} days) ${r.file} › ${r.test.slice(0, 70)}: ${r.error.slice(0, 80)}${r.ticket ? ` (ticket ${r.ticket})` : ' (no ticket)'}`);
  writeFileSync(join(dir, 'top.txt'), top.join('\n') + (top.length ? '\n' : ''));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'outcomes') outcomes(args[0]);
else if (cmd === 'add') add(args[0], args.slice(1));
else { console.error('usage: ledger.mjs outcomes <report.json> | add <ledger dir> <outcome files...>'); process.exit(2); }
