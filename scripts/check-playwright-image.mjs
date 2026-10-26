// The browser jobs run in Playwright's image (e2e.yml says why), whose browsers fit one Playwright version only: an image
// older or newer than the installed @playwright/test sends every job to download the right ones (e2e.yml's install step).
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { version } = createRequire(import.meta.url)('@playwright/test/package.json');
const root = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const files = readdirSync(root).filter((f) => f.endsWith('.yml'));
let images = 0, bad = 0;
for (const f of files) {
  for (const [, tag] of readFileSync(join(root, f), 'utf8').matchAll(/mcr\.microsoft\.com\/playwright:v([^\s-]+)/g)) {
    images++;
    if (tag !== version) {
      console.error(`.github/workflows/${f} runs in mcr.microsoft.com/playwright:v${tag}-noble, but @playwright/test is ${version}; bump the image to v${version}`);
      bad++;
    }
  }
}
// None found means the pattern no longer matches how the workflows name the image, not that all is well.
if (!images) { console.error('no job in .github/workflows runs in mcr.microsoft.com/playwright:v<version>; update this check'); bad++; }
if (bad) process.exit(1);
console.log(`playwright image ok (v${version}, ${images} jobs)`);
