import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, newSecret, test } from './fixtures';

// Every look of the theme picker (client/theme.ts), on one app in a lived-in state: a room with a friend in the call and
// sharing a screen, a few chat lines, an unread count on another room. Each theme is picked the way a friend picks it and
// photographed at desktop and phone width, so the owner can look through all of them from the CI artifact
// `theme-screenshots-chromium` (e2e.yml) without running anything, and a theme whose font is missing fails here.
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
      failed: faces.filter((f) => f.status === 'error').map((f) => `${unquote(f.family)} ${f.weight} ${f.style}`),
      notLoaded: [...used].filter((fam) => !faces.some((f) => unquote(f.family) === fam && f.status === 'loaded')),
    };
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
    expect(badFonts, `${name}: no font request failed`).toEqual([]);
  }

  // The pick is kept in this browser (localStorage `dave.theme`): after a reload the theme is on and the menu says so.
  // Out of the call first: what a reload does to a call is other tests' business.
  const kept = themes[themes.length - 1]!;
  await page.setViewportSize(DESKTOP);
  await alice.leave();
  await pick.selectOption(kept);
  await page.reload();
  await alice.connected();
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  await expect(pick).toHaveValue(kept);
});
