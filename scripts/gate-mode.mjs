#!/usr/bin/env node
/**
 * Where the gate's run of the browser suite goes (preview.yml, started by hand): against the pull request's preview, real
 * Cloudflare, while the previews' share of the day (core/relayusage.ts, SIDE_SHARES) has room for a run (RUN_COST), and
 * one more (below); else against a local build of the PR on GitHub's runners, which uses none of it. A PR waits for no
 * midnight that way: on 2026-11-18 the previews' share was used up by 01:20 UTC, and every PR with it (ticket 89).
 *
 *   MODE=auto|preview|local node scripts/gate-mode.mjs
 *
 * MODE other than auto is taken as it is. Writes `mode=preview` or `mode=local`, `short=…` (why, in a few words, for the
 * gate's status) and `why=…` to $GITHUB_OUTPUT, and why to the run's summary. Cloudflare not saying what the day used:
 * local, which is sure to have room, its status saying so. Room means room for two runs: Cloudflare's figures are
 * minutes behind, and another PR's gate may be under way, or have ended without being counted yet; past the share the
 * preview refuses sockets, every shard fails, and a re-run of its failed jobs would go to the preview again. Needs
 * CLOUDFLARE_ACCOUNT_ID and RELAY_USAGE_API_TOKEN (a token that reads the account's analytics).
 */
import { appendFileSync } from 'node:fs';
import { DAILY_LIMITS, FREE_PLAN, RUN_COST, SIDE_SHARES, freePlanRequest, monthSoFar, parseFreePlan, roomFor, sideOf } from '../src/core/relayusage.ts';

const out = (mode, short, why = short) => {
  console.log(`${mode}: ${why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\nshort=${short}\nwhy=${why}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `The browser suite runs against ${mode === 'preview' ? "the PR's preview" : 'a local build of the PR'}: ${why}\n`);
  process.exit(0);
};

const asked = process.env.MODE || 'auto';
if (asked === 'preview' || asked === 'local') out(asked, 'asked for', 'asked for by whoever started the run');

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.RELAY_USAGE_API_TOKEN;
if (!account || !token) out('local', "no token for Cloudflare's figures", "no token to ask Cloudflare what the previews' share has left");
const now = Date.now();
const req = freePlanRequest(account, token, now);
const today = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(20_000) })
  .then(async (res) => (res.ok ? parseFreePlan(await res.json(), monthSoFar(now).to) : null)).catch(() => null);
const previews = today && sideOf(today, 'preview');
if (!today || !previews) out('local', "Cloudflare's figures not known", "Cloudflare did not say what the previews' share has left");

const used = DAILY_LIMITS.map((k) => `${k} ${Math.round(previews[k]).toLocaleString('en')} used of ${Math.round(FREE_PLAN[k] * SIDE_SHARES.preview).toLocaleString('en')}`).join(', ');
const twoRuns = Object.fromEntries(DAILY_LIMITS.map((k) => [k, 2 * RUN_COST[k]]));
if (roomFor(today, 'preview', twoRuns)) out('preview', "room in the previews' share", `the previews' share has room for a run, and one more not yet counted (${used})`);
out('local', "the previews' share was used up", `the previews' share has no room for a run and one more not yet counted (${used})`);
