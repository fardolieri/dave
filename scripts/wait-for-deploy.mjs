// Waits until a deployed copy (E2E_URL, as playwright.config.ts reads it) serves the given commit, page and files alike
// (ticket 64). For about a minute after `wrangler deploy` returns, the edge can answer a page that names an `/assets/` file
// with a 404 for that file, one build ahead or behind it: a browser opening the app then loads nothing, and every test
// that opens a page in that minute fails on the console line. So e2e.yml runs this in each shard before the suite: the
// page must name files that load and carry the commit, several times in a row, since one good answer can be followed by
// a stale one. Nothing to wait for against a local build.
//   node scripts/wait-for-deploy.mjs <commit>
import { setTimeout as sleep } from 'node:timers/promises';
import { target } from '../e2e/browsers.ts';

const commit = process.argv[2];
if (!target) process.exit(0);
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) { console.error(`usage: wait-for-deploy.mjs <full commit hash>, got ${commit ?? 'nothing'}`); process.exit(2); }

const IN_A_ROW = 6; // checks 5 s apart: half a minute of answers that agree
const EVERY = 5_000;
const GIVE_UP = 6 * 60_000;

/** What is wrong with the copy's answer now, or '' when the page and every file it names are this commit's. */
async function check() {
  const get = async (path) => {
    const res = await fetch(new URL(path, target), { signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: await res.text() };
  };
  const page = await get('/');
  if (page.status !== 200) return `/ answered ${page.status}`;
  const files = [...page.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  if (!files.length) return '/ names no /assets/ file';
  let found = false;
  for (const file of files) {
    const res = await get(file);
    if (res.status !== 200) return `${file} answered ${res.status}`;
    // The build's commit is in the app's script (client/version.ts), not in the page.
    if (res.body.includes(commit)) found = true;
  }
  return found ? '' : `the files / names (${files.join(', ')}) are of another commit`;
}

const start = Date.now();
let good = 0;
let last = '';
while (good < IN_A_ROW) {
  if (Date.now() - start > GIVE_UP) {
    console.error(`${target} did not serve ${commit} steadily within ${GIVE_UP / 60_000} min; last: ${last || 'a good answer'}`);
    process.exit(1);
  }
  const problem = await check().catch((e) => `${e.name}: ${e.message}`);
  if (problem) good = 0; else good++;
  if (problem !== last) console.log(`${Math.round((Date.now() - start) / 1000)} s: ${problem || 'serves this commit'}`);
  last = problem;
  if (good < IN_A_ROW) await sleep(EVERY);
}
console.log(`${target} serves ${commit}, ${IN_A_ROW} answers in a row, after ${Math.round((Date.now() - start) / 1000)} s`);
