// What the agents' instructions name still exists. AGENTS.md and docs/agents/ are read at the start of every session and
// point on into the repo: a pointer to a file, a workflow or a constant that has since been renamed sends an agent
// looking for nothing, and no test notices (docs/agents/issue-tracker.md named a triage-labels.md that never existed).
// Checked: every `…` in them that is a path, a file's name or a NAME_IN_CAPITALS, and every docs/agents/ file named
// anywhere else in the repo. A constant counts as there while any line of the code still has the word, a comment too.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const docs = ['AGENTS.md', ...readdirSync(join(root, 'docs/agents')).map((f) => `docs/agents/${f}`)];
const git = (...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }); } catch { return ''; } };
/** Where a constant or an event's name may live: the code, its tests, the scripts and the workflows. */
const code = ['src', 'e2e', 'test', 'scripts', '.github', '*.ts', '*.jsonc', '*.json'];
const used = (word) => git('grep', '-lwF', '--', word, ...code) !== '';
/** A path, with a `*` for the rest of a name: `.scratch/p2p-friends-chat-build/issues/35-*`. */
const there = (path) => {
  if (!path.includes('*')) return existsSync(join(root, path));
  const [before] = path.split('*');
  return existsSync(join(root, dirname(before))) && readdirSync(join(root, dirname(before))).some((f) => f.startsWith(basename(before)));
};

/** Named, and not the working tree's: a file and the branches of another branch's making. */
const elsewhere = new Set(['causes.json', 'night-shift/*']);

const missing = [];
for (const doc of docs) {
  for (const [, name] of readFileSync(join(root, doc), 'utf8').matchAll(/`([^`\n]+)`/g)) {
    // A command, a placeholder, a path outside the repo, a slash command, a ref.
    if (/[\s<>…~$=]/.test(name) || /^\/[\w-]+$/.test(name) || name.startsWith('origin/') || elsewhere.has(name)) continue;
    const found =
      name.includes('/') ? there(name)
      : /\.(md|ya?ml|mjs|ts|tsx|sh|jsonc?)$/.test(name) ? [name, `.github/workflows/${name}`, join(dirname(doc), name)].some(there)
      : /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name) ? used(name)
      : true;
    if (!found) missing.push(`${doc} names \`${name}\`, which is not in the repo`);
  }
}
for (const line of git('grep', '-oE', 'docs/agents/[a-z0-9-]+\\.md', '--', '.', ':!.scratch').split('\n').filter(Boolean)) {
  const [file, path] = line.split(':');
  if (!existsSync(join(root, path))) missing.push(`${file} names ${path}, which is not in the repo`);
}

if (missing.length) {
  console.error(`The agents' instructions name what is gone (rename the pointer with the thing it points to):\n  ${[...new Set(missing)].join('\n  ')}`);
  process.exit(1);
}
console.log(`agent docs: ${docs.length} files name nothing that is gone`);
