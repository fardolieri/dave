import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { target } from './browsers';
import { expect, newSecret, test } from './fixtures';

// Every look of the theme picker (client/theme.ts), on one app in a lived-in state: a room with a friend in the call and
// sharing a screen, a few chat lines, an unread count on another room. Each theme is picked the way a friend picks it and
// photographed at desktop and phone width, the phone in light and dark mode, so the owner can look through all of them
// from the CI artifact `theme-screenshots-chromium-<shard>` (e2e.yml) without running anything; a theme whose font is
// missing, or that pushes the phone layout wider than the screen, fails here.
// The options are read from the page: a theme added to themes/ is covered without touching this file.

/** Where the screenshots go: their own folder, not e2e-results, which e2e.yml keeps only for failures and flakes. */
const SHOTS = 'e2e-themes';
const DESKTOP = { width: 1200, height: 800 };
const PHONE = { width: 390, height: 780 };

/**
 * Waits for the fonts the page now uses and says which of them did not load: font families on screen (the first of each
 * rendered text's list) that the page declares with @font-face but has no loaded face of, and faces that failed outright.
 * Two frames first, so the style of a theme just picked has been applied and its fonts asked for before `fonts.ready`.
 */
async function fontTrouble(page: Page): Promise<{ failed: string[]; notLoaded: string[] }> {
  const { failed, notLoaded } = await fontState(page);
  return { failed, notLoaded };
}

/** `fontTrouble`, and the declared families the page has on screen (`used`). */
async function fontState(page: Page): Promise<{ used: string[]; failed: string[]; notLoaded: string[] }> {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await document.fonts.ready;
    const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
    const faces: FontFace[] = [];
    document.fonts.forEach((f) => faces.push(f));
    const declared = new Set(faces.map((f) => unquote(f.family)));
    const used = new Set<string>();
    for (const el of document.querySelectorAll('body *')) {
      if (!el.checkVisibility() || ![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      const first = unquote(getComputedStyle(el).fontFamily.split(',')[0]!);
      if (declared.has(first)) used.add(first);
    }
    return {
      used: [...used].sort(),
      failed: faces.filter((f) => f.status === 'error').map((f) => `${unquote(f.family)} ${f.weight} ${f.style}`),
      notLoaded: [...used].filter((fam) => !faces.some((f) => unquote(f.family) === fam && f.status === 'loaded')),
    };
  });
}

/**
 * What scrolls sideways at phone width, as "what: scroll width > width": the page itself, the column that scrolls (`.scroll`),
 * the sidebar in it and the composer. A pixel of rounding is let through on the parts, whose widths are fractions.
 */
function sideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) out.push(`page: ${root.scrollWidth} > ${root.clientWidth}`);
    for (const sel of ['.scroll', '.side', '.chat-input']) {
      for (const el of document.querySelectorAll(sel)) if (el.scrollWidth > el.clientWidth + 1) out.push(`${sel}: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    return out;
  });
}

test('every theme applies, loads its fonts and keeps the console quiet, at desktop and phone width; the pick survives a reload', async ({ crowd }, testInfo) => {
  const room = { secret: newSecret(), name: 'Friday night' };
  const other = { secret: newSecret(), name: 'Board games' };
  const alice = await crowd.open('Alice', { rooms: [room, other], viewport: DESKTOP });
  // Bob shares his screen, which only Chromium's fake capture does without a picker (share.spec.ts).
  const bob = await crowd.open('Bob', { rooms: [other, room], engine: 'chromium' });
  // An unread count on Board games: Bob writes there once Alice is in it too, while she looks at Friday night.
  await expect.poll(() => bob.online(), { message: 'Alice is in Board games too' }).toContain('Alice');
  await bob.say('anyone up for Carcassonne on Sunday?');
  await expect(alice.page.locator('button.room-name', { hasText: 'Board games' }).locator('.unread')).toHaveText('1');
  await bob.selectRoom('Friday night');
  await alice.say('evening! who is around?');
  await bob.say('me, give me a minute to find my headphones');
  await alice.say('no rush 🎧');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await bob.startShare();
  await expect(alice.tile('Bob')).toHaveClass(/share-closed/);

  const page = alice.page;
  const pick = page.getByRole('combobox', { name: 'Theme', exact: true });
  const themes = await pick.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(themes.length, 'the picker offers the default look and at least one theme').toBeGreaterThan(1);

  // A font file the server does not have, or one the browser gives up on.
  const badFonts: string[] = [];
  page.on('response', (r) => { if (/\.woff2(\?|$)/.test(r.url()) && r.status() >= 400) badFonts.push(`${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { if (/\.woff2(\?|$)/.test(r.url())) badFonts.push(`${r.failure()?.errorText} ${r.url()}`); });

  const dir = join(SHOTS, testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  const shoot = async (name: string) => {
    const body = await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' });
    // As a body, not a path: a path is copied into e2e-results, which e2e.yml would then keep as a flaky test's leftovers.
    await testInfo.attach(name, { body, contentType: 'image/png' });
  };
  /** Back to the top of whatever scrolls: picking scrolls the sidebar down to the picker. */
  const toTop = () => page.evaluate(() => { for (const el of document.querySelectorAll('.side, .scroll')) el.scrollTop = 0; });

  for (const value of themes) {
    const name = value || 'default';
    await page.setViewportSize(DESKTOP);
    await pick.selectOption(value);
    await pick.blur();
    if (value) await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    else await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    await expect.poll(() => fontTrouble(page), { message: `${name}: every font on screen loaded` }).toEqual({ failed: [], notLoaded: [] });
    await toTop();
    await shoot(`${name}-desktop`);

    // Phone width (styles.css, max-width: 700px): one column that scrolls as a whole, the composer pinned below it.
    await page.setViewportSize(PHONE);
    await expect.poll(() => fontTrouble(page), { message: `${name}: every font on screen loaded at phone width` }).toEqual({ failed: [], notLoaded: [] });
    await toTop();
    await shoot(`${name}-phone`);
    await page.locator('.scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shoot(`${name}-phone-chat`);
    await expect.poll(() => sideways(page), { message: `${name}: nothing scrolls sideways at phone width` }).toEqual([]);

    // Dark mode: the themes that follow the system's (prefers-color-scheme) have a palette nobody sees otherwise.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => fontTrouble(page), { message: `${name}: every font on screen loaded in dark mode` }).toEqual({ failed: [], notLoaded: [] });
    await toTop();
    await shoot(`${name}-phone-dark`);
    await expect.poll(() => sideways(page), { message: `${name}: nothing scrolls sideways at phone width in dark mode` }).toEqual([]);
    await page.emulateMedia({ colorScheme: 'light' }); // the context's own
    expect(badFonts, `${name}: no font request failed`).toEqual([]);
  }

  // The pick is kept in this browser (localStorage `dave.theme`): after a reload the theme is on and the menu says so.
  // Out of the call first: what a reload does to a call is other tests' business.
  const kept = themes[themes.length - 1]!;
  await page.setViewportSize(DESKTOP);
  await alice.leave();
  await pick.selectOption(kept);
  await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; }); // as below: a reload must not cut off a font download
  await page.reload();
  await alice.connected();
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  await expect(pick).toHaveValue(kept);
});

test('a stored theme whose file a later deploy dropped reads as the default look, and a theme picked then is kept', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { connect: false });
  // Before the app reads it, and once: the reload below keeps what the app stores.
  await alice.context.addInitScript(() => {
    if (localStorage.getItem('dave.e2e-theme-seeded')) return;
    localStorage.setItem('dave.e2e-theme-seeded', '1');
    localStorage.setItem('dave.theme', 'fd-gone-in-a-later-deploy');
  });
  await alice.open();
  const page = alice.page;
  const pick = page.getByRole('combobox', { name: 'Theme', exact: true });
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(pick).toHaveValue('');

  const themes = await pick.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  const kept = themes[0]!;
  await pick.selectOption(kept);
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  // Its fonts first: a reload cuts off a font still downloading, and Firefox logs that as an error (NS_BINDING_ABORTED).
  await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; });
  await page.reload();
  await alice.connected();
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  await expect(pick).toHaveValue(kept);
});

test('a theme\'s own fonts load with the server gone, from the service worker', async ({ crowd }) => {
  // The outage is staged at the preview server (vite.config.ts), as in update.spec.ts.
  test.skip(!!target, 'needs the preview server (vite.config.ts): an outage is staged there, not in a deployed copy');
  const alice = await crowd.open('Alice');
  const page = alice.page;
  // Picked once the worker serves the page, so the font files are fetched through it, which keeps a copy (sw.ts, `fonts`).
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: 'a service worker serves the page' }).toBe(true);
  // A theme with two families of its own, in our Worker's fonts/ (themes/fd-lounge.css).
  const theme = 'fd-lounge';
  const families = ['Figtree', 'Young Serif'];
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
  /** Every font on screen loaded, the theme's two among them. */
  const fonts = async () => { const f = await fontState(page); return { ...f, used: families.filter((fam) => f.used.includes(fam)) }; };
  const loaded = { failed: [], notLoaded: [], used: families };
  await expect.poll(fonts, { message: `${theme}: its fonts loaded` }).toEqual(loaded);

  // The server cuts every connection before answering, the socket too: the page comes from the service worker, and so
  // must the fonts, or the theme falls back to the system's.
  await alice.context.addCookies([{ name: 'e2e-outage', value: '1', url: new URL(page.url()).origin }]);
  await alice.wire.cut();
  await page.reload();
  await expect(page.locator('aside.side')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect.poll(fonts, { message: `${theme}: its fonts loaded while the server is gone`, timeout: 20_000 }).toEqual(loaded);

  await alice.context.clearCookies({ name: 'e2e-outage' });
  alice.wire.restore();
  await alice.connected();
  await expect.poll(fonts, { message: `${theme}: its fonts still loaded once the server is back` }).toEqual(loaded);
});
