// src/core must stay runtime-neutral: no Cloudflare, Node, browser, or framework imports.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/core/', import.meta.url).pathname;
const banned = [/^cloudflare:/, /^node:/, /^@cloudflare\//, /^solid-js/, /^@solidjs\//, /^ws$/];
const files = readdirSync(root).filter((f) => f.endsWith('.ts'));
const importRe = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm;
let bad = 0;
for (const f of files) {
  const src = readFileSync(join(root, f), 'utf8');
  for (const [, spec] of src.matchAll(importRe)) {
    const external = !spec.startsWith('.');
    if (external && banned.some((re) => re.test(spec))) { console.error(`src/core/${f} imports ${spec}`); bad++; }
    else if (external) { console.error(`src/core/${f} imports external module ${spec}; core takes no dependencies`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(`core isolation ok (${files.length} files)`);
