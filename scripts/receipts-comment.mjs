// Writes the one receipts comment of a pull request, or rewrites it in place: it is found by the marker on its first line
// (.github/workflows/receipts.yml).
//   node scripts/receipts-comment.mjs <dir>     the receipts in <dir>/{before,after}/{phone,desktop}/, as published by
//                                               receipts-publish.sh under pr-<PR>/<HEAD_SHA>/ on the receipts branch
//   node scripts/receipts-comment.mjs --closed  the PR is closed and its receipts are gone from the branch
// Env: GH_TOKEN, GITHUB_REPOSITORY, PR, and for receipts HEAD_SHA, BASE_SHA, RUN_URL.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '<!-- dave-receipts -->';
const { GH_TOKEN, GITHUB_REPOSITORY: repo, PR: pr, HEAD_SHA: head = '', BASE_SHA: base = '', RUN_URL: run = '' } = process.env;
const arg = process.argv[2];
const short = (sha) => sha.slice(0, 7);

/** title and outcome of each filmed test, by side, viewport and file name */
function receipts(dir) {
  const found = new Map(); // name -> { title, before: { phone, desktop }, after: { ... } }
  for (const side of ['before', 'after']) {
    for (const view of ['phone', 'desktop']) {
      const at = join(dir, side, view);
      if (!existsSync(at)) continue;
      for (const f of readdirSync(at).filter((f) => f.endsWith('.json')).sort()) {
        const name = f.slice(0, -'.json'.length);
        const { title, status } = JSON.parse(readFileSync(join(at, f), 'utf8'));
        const entry = found.get(name) ?? { title, before: {}, after: {} };
        if (side === 'after') entry.title = title;
        entry[side][view] = { status, gif: existsSync(join(at, `${name}.gif`)) ? `${side}/${view}/${name}.gif` : null };
        found.set(name, entry);
      }
    }
  }
  return found;
}

function body(dir) {
  const raw = `https://raw.githubusercontent.com/${repo}/receipts/pr-${pr}/${head}`;
  const lines = [MARKER, '### Video receipts', '', `Filmed in CI for ${short(head)} against a local build, Chromium with a fake microphone and screen ([run](${run})). Before is master at ${short(base)} with this PR's tour. Tap a GIF to open it full size.`];
  const found = receipts(dir);
  if (found.size === 0) lines.push('', 'Nothing was filmed: see the run.');
  const failed = [];
  for (const { title, before, after } of found.values()) {
    lines.push('', `#### ${title}`);
    for (const view of ['phone', 'desktop']) {
      const shot = (side) => {
        const r = side === 'before' ? before[view] : after[view];
        if (r?.status === 'failed') failed.push(`${side}, ${view}: ${title}`);
        return r?.gif ? `<a href="${raw}/${r.gif}"><img src="${raw}/${r.gif}" width="49%" alt="${side}, ${view}"></a>` : null;
      };
      const pair = [shot('before'), shot('after')];
      if (pair.every((s) => s === null)) continue;
      lines.push('', `**${view}**: ${pair[0] ? 'before (master) · after (this PR)' : 'this PR (nothing filmed on master)'}`, '', pair.filter(Boolean).join(' '));
    }
  }
  if (failed.length) lines.push('', `Did not run to the end (the GIF shows how far it got; on master a new receipt test is expected to fail):`, '', ...failed.map((f) => `- ${f}`));
  return lines.join('\n');
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function existing() {
  for (let page = 1; ; page++) {
    const comments = await api(`/issues/${pr}/comments?per_page=100&page=${page}`);
    const mine = comments.find((c) => c.body?.startsWith(MARKER));
    if (mine || comments.length < 100) return mine;
  }
}

const text = arg === '--closed'
  ? `${MARKER}\n### Video receipts\n\nRemoved from the receipts branch when this PR closed. The GIFs stay in the last run's artifacts for 30 days.`
  : body(arg);
const old = await existing();
if (old) await api(`/issues/comments/${old.id}`, { method: 'PATCH', body: JSON.stringify({ body: text }) });
else if (arg !== '--closed') await api(`/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) });
console.log(old ? `updated ${old.html_url}` : 'commented');
