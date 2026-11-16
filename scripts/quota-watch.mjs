#!/usr/bin/env node
/**
 * Tells the owner when the account has used much of one of the Workers Free plan's daily limits (quota-watch.yml, every
 * quarter of an hour): at 40 % and at 70 % (core/relayusage.ts, ALERT_SHARES), each once a day. Past a limit every Durable
 * Object of the account fails until midnight UTC, and nothing said so before it did (ticket 84: 2026-11-16, no room let
 * anyone in from 18:42 UTC; 40 % was passed two hours earlier).
 *
 * It asks Cloudflare itself, as the Worker does for the About dialog (the same question and the same reading of the
 * answer, core/relayusage.ts), so it tells with the live site down too. One issue labelled `quota` per day, its title
 * saying the step told; a higher step is a comment there. A step told for the first time ends the run red, which is what
 * mails the owner; every other run is green, one in which GitHub or Cloudflare did not answer too. Issues of days gone
 * by are closed, on every run.
 *
 *   node scripts/quota-watch.mjs [--dry-run]
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and RELAY_USAGE_API_TOKEN (a token that reads the account's analytics), and for the issue
 * GH_TOKEN and GITHUB_REPOSITORY. `--dry-run` asks Cloudflare and says what it would do. RUN_URL is linked.
 */
import { appendFileSync } from 'node:fs';
import { DAILY_LIMITS, FREE_PLAN, alertStep, dayEnds, elapsedOf, freePlanRequest, fullest, monthSoFar, parseFreePlan } from '../src/core/relayusage.ts';

const dry = process.argv.includes('--dry-run');
const now = Date.now();
const day = monthSoFar(now).to;
const NAMES = {
  compute: 'Durable Object time (GB-s, a Room awake)',
  objectRequests: 'Requests to Durable Objects',
  workerRequests: 'Requests to the Worker',
  rowsWritten: 'Rows written',
  rowsRead: 'Rows read',
};
const percent = (share) => `${Math.round(share * 100)} %`;
const say = (line) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const cfToken = process.env.RELAY_USAGE_API_TOKEN;
if (!account || !cfToken) { say('::warning::quota watch: no CLOUDFLARE_ACCOUNT_ID or RELAY_USAGE_API_TOKEN, nothing asked'); process.exit(0); }

const req = freePlanRequest(account, cfToken, now);
const today = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(20_000) })
  .then(async (res) => (res.ok ? parseFreePlan(await res.json(), day) : null)).catch(() => null);
// Not known is not an alarm: Cloudflare's API fails now and then, and the next run asks again.
if (!today) { say(`::warning::quota watch: Cloudflare did not say what ${day} has used`); process.exit(0); }

const { limit, share } = fullest(today);
const step = alertStep(share);
const elapsed = elapsedOf('day', now);
const table = [
  '| Daily limit | Used | Of | Share |',
  '|---|---|---|---|',
  ...DAILY_LIMITS.map((k) => `| ${NAMES[k]} | ${Math.round(today[k]).toLocaleString('en')} | ${FREE_PLAN[k].toLocaleString('en')} | ${percent(today[k] / FREE_PLAN[k])} |`),
].join('\n');
const at = new Date(now).toISOString().slice(11, 16);
say(`${day} ${at} UTC: ${percent(share)} of the day's ${NAMES[limit]} used, ${percent(elapsed)} of the day gone.`);

const title = `Free plan ${day}: told at ${step} % of a daily limit`;
// When the day's limit is gone at this pace: said only if that is before the day ends.
const gone = elapsed > 0 && share > 0 ? now - elapsed * 86_400_000 + (elapsed * 86_400_000) / share : Infinity;
const pace = share < 1 && gone < dayEnds(now) ? ` At this pace it is used up at about ${new Date(gone).toISOString().slice(11, 16)} UTC.` : '';
const body = [
  `**${percent(share)} of the day's ${NAMES[limit]} is used, at ${at} UTC** (${percent(elapsed)} of the day gone).${pace}`,
  '',
  'Past a limit every Durable Object of the account fails until 00:00 UTC: no room lets anyone in, and no pull request\'s preview can run its tests. From 12,000 GB-s of Durable Object time on the live site lets no new socket into a room (`OWN_COMPUTE_LIMIT`, wrangler.jsonc); the last 1,000 are meant for the previews.',
  '',
  table,
  '',
  'What used it: Cloudflare\'s analytics by Worker and by Room (`durableObjectsPeriodicGroups`: `duration` and `activeTime` by `namespaceId`, `objectId`, `datetimeMinute`). A Room active every second of a minute with no frames is one kept awake (ticket 84, `.scratch/p2p-friends-chat-build/issues/84-rooms-kept-awake-free-plan-used-up.md`).',
  ...(process.env.RUN_URL ? ['', `Run: ${process.env.RUN_URL}`] : []),
].join('\n');

if (dry) { say(step === 0 ? 'dry run: nothing to tell' : `dry run: would tell at ${step} %:\n\n# ${title}\n\n${body}`); process.exit(0); }

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
  });
  if (!res.ok && res.status !== 422) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

// What was told already, and the issues of days gone by closed: on every run, a quiet one too, or yesterday's issue
// would stay open, and in every session's briefing, until a later day had something to tell. Today's is looked for
// among the closed ones as well: the owner closing it does not make its step news again.
const TOLD = /^Free plan (\d{4}-\d{2}-\d{2}): told at (\d+) %/;
let mine = null;
try {
  for (const issue of await api('/issues?labels=quota&state=all&per_page=100')) {
    const m = TOLD.exec(issue.title);
    if (!m || issue.pull_request) continue;
    if (m[1] === day) { if (!mine || Number(m[2]) > mine.told) mine = { number: issue.number, told: Number(m[2]) }; }
    // A day gone by: its limits started anew at midnight.
    else if (m[1] < day && issue.state === 'open') await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
  }
} catch (e) {
  // GitHub failing is not news about the plan: no red run for it. The next run looks again.
  say(`::warning::quota watch: GitHub did not answer (${String(e).slice(0, 200)})`);
  process.exit(0);
}

if (step === 0) process.exit(0);
if (mine && mine.told >= step) { say(`Told already at ${mine.told} % (#${mine.number}).`); process.exit(0); }
if (mine) {
  // The title first: it is what says the step was told, should the comment fail.
  await api(`/issues/${mine.number}`, { method: 'PATCH', body: JSON.stringify({ title, state: 'open' }) });
  await api(`/issues/${mine.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  say(`Told at ${step} %: a comment on #${mine.number}.`);
} else {
  // The label, once; 422 when it is already there.
  await api('/labels', { method: 'POST', body: JSON.stringify({ name: 'quota', color: 'b60205', description: "Much of a daily limit of Cloudflare's free plan is used (quota-watch.yml)" }) });
  const made = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: ['quota'] }) });
  say(`Told at ${step} %: issue #${made.number}.`);
}
// Red on purpose: a failed run is what mails the owner (AGENTS.md).
process.exit(1);
