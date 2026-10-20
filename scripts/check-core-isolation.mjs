// src/core must stay runtime-neutral: no Cloudflare, Node, browser, or framework imports.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/core/', import.meta.url).pathname;
const files = readdirSync(root).filter((f) => f.endsWith('.ts'));
// `import x from 'y'`, `export … from 'y'`, `import 'y'` and `import('y')`.
const importRe = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/gm;
let bad = 0;
for (const f of files) {
  const src = readFileSync(join(root, f), 'utf8');
  for (const [, from, bare] of src.matchAll(importRe)) {
    const spec = from ?? bare;
    if (!spec.startsWith('.')) { console.error(`src/core/${f} imports ${spec}; core takes no dependencies`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(`core isolation ok (${files.length} files)`);
