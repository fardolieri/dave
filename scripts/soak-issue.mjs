#!/usr/bin/env node
/**
 * Files what a failed soak shard found (soak.yml): one issue labelled `soak` per way of failing. A report whose signature
 * (the `soak-signature` marker: its kinds and first line without names or large numbers, e2e/soak/model.ts) an open issue
 * already carries becomes a comment there, and the issue's title counts the times.
 *
 *   node scripts/soak-issue.mjs <folder with report.json and report.md> [...]
 *
 * Needs GH_TOKEN and GITHUB_REPOSITORY. RUN_URL is linked; DEPLOYED, when set, says nightly was redeployed during the run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

// The label, once; 422 when it is already there.
await api('/labels', { method: 'POST', body: JSON.stringify({ name: 'soak', color: 'b60205', description: 'Found by the nightly chaos soak (soak.yml)' }) });

const open = await api('/issues?labels=soak&state=open&per_page=100');
for (const dir of process.argv.slice(2)) {
  if (!existsSync(join(dir, 'report.json'))) { console.log(`${dir}: no report`); continue; }
  const r = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  let body = readFileSync(join(dir, 'report.md'), 'utf8');
  if (process.env.DEPLOYED) body = `> Nightly was redeployed while this ran (${process.env.DEPLOYED}): the change of version may be what failed.\n\n${body}`;
  const sequence = `<!-- soak-sequence: ${r.hash} -->`;
  const signed = r.signature ? `<!-- soak-signature: ${r.signature} -->` : null;
  // By signature when the report has one; the list only for reports from before signatures. Two different failures of
  // one list must not share an issue.
  const same = open.find((i) => (signed ? i.body?.includes(signed) : i.body?.includes(sequence)));
  if (same) {
    await api(`/issues/${same.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Seen again${process.env.RUN_URL ? ` in ${process.env.RUN_URL}` : ''}.\n\n${body}` }) });
    const seen = Number(/\(seen (\d+) times\)$/.exec(same.title)?.[1] ?? 1) + 1;
    same.title = `${same.title.replace(/ \(seen \d+ times\)$/, '')} (seen ${seen} times)`;
    await api(`/issues/${same.number}`, { method: 'PATCH', body: JSON.stringify({ title: same.title }) });
    console.log(`${dir}: commented on #${same.number}, seen ${seen} times`);
  } else {
    const made = await api('/issues', { method: 'POST', body: JSON.stringify({ title: r.title, body, labels: ['soak'] }) });
    open.push(made);
    console.log(`${dir}: opened #${made.number}`);
  }
}
