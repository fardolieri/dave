#!/usr/bin/env node
/**
 * Tells the owner when the live site or the previews have used much of their share of one of the Workers Free plan's
 * daily limits (quota-watch.yml, every quarter of an hour): at 70 % and at 90 % of it (core/relayusage.ts, ALERT_SHARES,
 * SIDE_SHARES), each once a day. Past its share a side lets no one into its rooms until midnight UTC; past the limit
 * itself every Durable Object of the account fails, and nothing said so before it did (ticket 84: 2026-11-16, no room
 * let anyone in from 18:42 UTC; 2026-11-17, from 20:44, the previews' runs).
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
import { DAILY_LIMITS, FREE_PLAN, SIDE_SHARES, alertStep, dayEnds, elapsedOf, freePlanRequest, fullestOf, monthSoFar, parseFreePlan, sideOf } from '../src/core/relayusage.ts';

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

// Each side, against its share: the live site, and the previews together. Each its own step and its own issue a day: the
// previews told at 90 % do not keep the live site's 70 % from being told.
const SIDES = { live: 'the live site', preview: 'the previews' };
const elapsed = elapsedOf('day', now);
const at = new Date(now).toISOString().slice(11, 16);
const live = sideOf(today, 'live');
const previews = sideOf(today, 'preview');
const count = (n) => Math.round(n).toLocaleString('en');
const part = (figures, side, k) => `${count(figures[k])} (${percent(figures[k] / (FREE_PLAN[k] * SIDE_SHARES[side]))})`;
const table = [
  `| Daily limit | Live site (of its share) | Previews (of theirs) | Account | Of | Share |`,
  '|---|---|---|---|---|---|',
  ...DAILY_LIMITS.map((k) => `| ${NAMES[k]} | ${part(live, 'live', k)} | ${part(previews, 'preview', k)} | ${count(today[k])} | ${FREE_PLAN[k].toLocaleString('en')} | ${percent(today[k] / FREE_PLAN[k])} |`),
].join('\n');
const news = Object.entries(SIDES).map(([side, who]) => {
  const { limit, share } = fullestOf(today, side);
  const step = alertStep(share);
  const of = `${side === 'live' ? 'its' : 'their'} ${percent(SIDE_SHARES[side])} share of`;
  say(`${day} ${at} UTC: ${who} used ${percent(share)} of ${of} the day's ${NAMES[limit]}, ${percent(elapsed)} of the day gone.`);
  // The step first, then the side, as TOLD reads them.
  const title = `Free plan ${day}: told at ${step} % (${who}, ${NAMES[limit]})`;
  // When the side's share is gone at this pace: said only if that is before the day ends.
  const gone = elapsed > 0 && share > 0 ? now - elapsed * 86_400_000 + (elapsed * 86_400_000) / share : Infinity;
  const pace = share < 1 && gone < dayEnds(now) ? ` At this pace it is used up at about ${new Date(gone).toISOString().slice(11, 16)} UTC.` : '';
  const body = [
    `**${who[0].toUpperCase()}${who.slice(1)} used ${percent(share)} of ${of} the day's ${NAMES[limit]}, at ${at} UTC** (${percent(elapsed)} of the day gone).${pace}`,
    '',
    `The live site gets ${percent(SIDE_SHARES.live)} of every daily limit and the previews ${percent(SIDE_SHARES.preview)} (\`SIDE_SHARES\`, src/core/relayusage.ts; \`FREE_PLAN_SHARES\`, wrangler.jsonc): past its share, a side's Worker lets no new socket into a room until 00:00 UTC, and the other side goes on. For the live site that is the friends locked out; for the previews, no pull request's preview can run its tests. Past a limit itself every Durable Object of the account fails, both sides'.`,
    '',
    table,
    '',
    'What used it: Cloudflare\'s analytics by Worker and by Room (`durableObjectsPeriodicGroups`: `duration` and `activeTime` by `namespaceId`, `objectId`, `datetimeMinute`; `durableObjectsInvocationsAdaptiveGroups`: `requests` by `namespaceId`, `type`). A Room active every second of a minute with no frames is one kept awake (ticket 84); a preview\'s rooms are its suite\'s (ticket 89).',
    ...(process.env.RUN_URL ? ['', `Run: ${process.env.RUN_URL}`] : []),
  ].join('\n');
  return { who, step, title, body };
});

if (dry) {
  for (const n of news) say(n.step === 0 ? `dry run: nothing to tell of ${n.who}` : `dry run: would tell at ${n.step} %:\n\n# ${n.title}\n\n${n.body}`);
  process.exit(0);
}

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

// What was told already, per side, and the issues of days gone by closed: on every run, a quiet one too, or yesterday's
// issue would stay open, and in every session's briefing, until a later day had something to tell. Today's are looked
// for among the closed ones as well: the owner closing one does not make its step news again. An issue from before the
// sides (no side in its title) is no side's.
const TOLD = /^Free plan (\d{4}-\d{2}-\d{2}): told at (\d+) %(?: \(([^,]+),)?/;
const mine = {};
try {
  for (const issue of await api('/issues?labels=quota&state=all&per_page=100')) {
    const m = TOLD.exec(issue.title);
    if (!m || issue.pull_request) continue;
    if (m[1] === day) { if (m[3] && (!mine[m[3]] || Number(m[2]) > mine[m[3]].told)) mine[m[3]] = { number: issue.number, told: Number(m[2]) }; }
    // A day gone by: its limits started anew at midnight.
    else if (m[1] < day && issue.state === 'open') await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
  }
} catch (e) {
  // GitHub failing is not news about the plan: no red run for it. The next run looks again.
  say(`::warning::quota watch: GitHub did not answer (${String(e).slice(0, 200)})`);
  process.exit(0);
}

let told = false;
for (const { who, step, title, body } of news) {
  const issue = mine[who];
  if (step === 0) continue;
  if (issue && issue.told >= step) { say(`${who}: told already at ${issue.told} % (#${issue.number}).`); continue; }
  if (issue) {
    // The title first: it is what says the step was told, should the comment fail.
    await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ title, state: 'open' }) });
    await api(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    say(`${who}: told at ${step} %, a comment on #${issue.number}.`);
  } else {
    // The label, once; 422 when it is already there.
    await api('/labels', { method: 'POST', body: JSON.stringify({ name: 'quota', color: 'b60205', description: "Much of a daily limit of Cloudflare's free plan is used (quota-watch.yml)" }) });
    const made = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels: ['quota'] }) });
    say(`${who}: told at ${step} %, issue #${made.number}.`);
  }
  told = true;
}
// Red on purpose: a failed run is what mails the owner (AGENTS.md).
process.exit(told ? 1 : 0);
