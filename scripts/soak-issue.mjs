#!/usr/bin/env node
/**
 * Files what a failed soak shard found (soak.yml): one issue labelled `soak` per shortest failing list. A report whose list
 * an open issue already carries (the `soak-sequence` marker, a hash of the list) becomes a comment there instead of a
 * second issue.
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
  const marker = `<!-- soak-sequence: ${r.hash} -->`;
  const same = open.find((i) => i.body?.includes(marker));
  if (same) {
    await api(`/issues/${same.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Seen again${process.env.RUN_URL ? ` in ${process.env.RUN_URL}` : ''}.\n\n${body}` }) });
    console.log(`${dir}: commented on #${same.number}`);
  } else {
    const made = await api('/issues', { method: 'POST', body: JSON.stringify({ title: r.title, body, labels: ['soak'] }) });
    open.push(made);
    console.log(`${dir}: opened #${made.number}`);
  }
}
