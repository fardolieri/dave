// Every mask in the themes (src/client/themes/*.css) has its -webkit- twin. Chromium before 120 (Android 7's last
// Chrome, older Samsung Internet and WebViews) knows masks only as -webkit-mask, and a shape cut out by a mask it
// ignores shows as the solid box under it. The browser suite runs current browsers only, so it cannot see this.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/client/themes/', import.meta.url).pathname;
const bare = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const has = (prop) => new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(body);
    if ((has('mask') || has('mask-image')) && !(has('-webkit-mask') || has('-webkit-mask-image'))) bare.push(`${file}: ${selector.trim().slice(0, 100)}`);
  }
}
if (bare.length) {
  console.error(`A mask without its -webkit- twin (an older Chromium shows a solid box instead):\n  ${bare.join('\n  ')}`);
  process.exit(1);
}
