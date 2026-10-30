import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { target } from './browsers';
import { expect, newSecret, openRoomMenu, test, pickTheme, pickedTheme, themeNames } from './fixtures';

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

/**
 * The endless CSS animations on the page whose style says they run, by name, without the app's own cues of something
 * going on (a dot pulsing while it connects, a spinner, a speaking ring): a theme's moving background must not be among
 * them for someone who asked for less motion (styles.css, --ambient-play). Read from the style, not from each animation's
 * play state: a screenshot with animations disabled restarts them by script, after which the style no longer pauses them.
 */
async function endless(page: Page): Promise<string[]> {
  const cues = ['pulse', 'spin', 'fd-lounge-glow'];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const running = await page.evaluate((cues) => document.getAnimations().flatMap((a) => {
    const effect = a.effect as KeyframeEffect | null;
    if (!(a instanceof CSSAnimation) || cues.includes(a.animationName) || !effect?.target || effect.getComputedTiming().iterations !== Infinity) return [];
    const style = getComputedStyle(effect.target, effect.pseudoElement);
    const states = style.animationPlayState.split(',').map((s) => s.trim());
    const at = style.animationName.split(',').map((s) => s.trim()).indexOf(a.animationName);
    return states[at % states.length] === 'paused' ? [] : [a.animationName];
  }), cues);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return running;
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
  const themes = await themeNames(page);
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
    await pickTheme(page, value);
    if (value) await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    else await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    await expect.poll(() => fontTrouble(page), { message: `${name}: every font on screen loaded` }).toEqual({ failed: [], notLoaded: [] });
    // Someone who asked for less motion: whatever the theme moves stands still.
    expect(await endless(page), `${name}: nothing moves on its own with reduced motion`).toEqual([]);
    await toTop();
    await shoot(`${name}-desktop`);
    // Each room and the chat of a room wear their own look inside the page's: the next look on the folded room and the
    // chat, for this one's page around them (so every look is seen in a box once). Set on the elements for the shot only.
    const next = themes[(themes.indexOf(value) + 1) % themes.length] || 'default';
    const was = await page.evaluate((n) => {
      const els = [document.querySelector<HTMLElement>('aside.side section.room:not(.selected)'), document.querySelector<HTMLElement>('.chat:not(.private)'), document.querySelector<HTMLElement>('form.chat-input')];
      const before = els.map((e) => e?.getAttribute('data-theme') ?? null);
      for (const e of els) e?.setAttribute('data-theme', n);
      return before;
    }, next);
    await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; });
    await shoot(`${name}-desktop-around-${next}`);
    await page.evaluate((before) => {
      const els = [document.querySelector<HTMLElement>('aside.side section.room:not(.selected)'), document.querySelector<HTMLElement>('.chat:not(.private)'), document.querySelector<HTMLElement>('form.chat-input')];
      els.forEach((e, i) => { if (!e) return; if (before[i] === null) e.removeAttribute('data-theme'); else e.setAttribute('data-theme', before[i]!); });
    }, was);

    // Phone width (styles.css, max-width: 700px): one column that scrolls as a whole, the composer pinned below it.
    await page.setViewportSize(PHONE);
    await expect.poll(() => fontTrouble(page), { message: `${name}: every font on screen loaded at phone width` }).toEqual({ failed: [], notLoaded: [] });
    await toTop();
    await shoot(`${name}-phone`);
    await page.locator('.scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shoot(`${name}-phone-chat`);
    expect(await endless(page), `${name}: nothing moves on its own with reduced motion, at phone width`).toEqual([]);
    await expect.poll(() => sideways(page), { message: `${name}: nothing scrolls sideways at phone width` }).toEqual([]);

    // Dark mode: the themes that follow the system's (prefers-color-scheme) have a palette nobody sees otherwise.
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => fontTrouble(page), { message: `${name}: every font on screen loaded in dark mode` }).toEqual({ failed: [], notLoaded: [] });
    await toTop();
    await shoot(`${name}-phone-dark`);
    expect(await endless(page), `${name}: nothing moves on its own with reduced motion, in dark mode`).toEqual([]);
    await expect.poll(() => sideways(page), { message: `${name}: nothing scrolls sideways at phone width in dark mode` }).toEqual([]);
    await page.emulateMedia({ colorScheme: 'light' }); // the context's own
    expect(badFonts, `${name}: no font request failed`).toEqual([]);
  }

  // The pick is kept in this browser (localStorage `dave.theme`): after a reload the theme is on and the menu says so.
  // Out of the call first: what a reload does to a call is other tests' business.
  const kept = themes[themes.length - 1]!;
  await page.setViewportSize(DESKTOP);
  await alice.leave();
  await pickTheme(page, kept);
  await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; }); // as below: a reload must not cut off a font download
  await page.reload();
  await alice.connected();
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  await expect.poll(() => pickedTheme(page)).toBe(kept);
});

test('each room wears its own look: the page the top room\'s, a room\'s box and its chat their own, kept over a reload', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const page = alice.page;
  const look = (await themeNames(page)).filter(Boolean)[0]!;
  const box = (name: string) => page.locator('aside.side section.room', { has: page.locator('.room-title', { hasText: name }) });
  await pickTheme(page, look); // for Room, the top one
  await expect(page.locator('html')).toHaveAttribute('data-theme', look);
  await expect(box('Room')).toHaveAttribute('data-theme', look);
  await expect(box('Other')).toHaveAttribute('data-theme', 'default');
  // Other on screen: its chat in its own look, the page still the top room's.
  await alice.selectRoom('Other');
  await expect(page.locator('html')).toHaveAttribute('data-theme', look);
  await expect(page.locator('.chat:not(.private)')).toHaveAttribute('data-theme', 'default');
  // Other to the top, from its ⋯: still on screen and open, the page in its look now, Room's box in its own.
  await box('Other').locator('button.room-more').click();
  await box('Other').locator('.room-menu').getByRole('button', { name: 'Put on top' }).click();
  await expect(page.locator('aside.side section.room').first()).toContainText('Other');
  await expect(box('Other')).toHaveClass(/\bselected\b/);
  await expect(box('Other')).not.toHaveClass(/\bfolded\b/);
  await expect(page.locator('.chat:not(.private)')).not.toHaveAttribute('data-theme');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(box('Room')).toHaveAttribute('data-theme', look);
  await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; }); // a reload must not cut off a font download
  await page.reload();
  await alice.connected();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(box('Room')).toHaveAttribute('data-theme', look);
});
test('a room\'s ⋯ menu and the cards opened from it wear its look, not the page\'s, and a folded room has no ⋯', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const page = alice.page;
  const box = (name: string) => page.locator('aside.side section.room', { has: page.locator('.room-title', { hasText: name }) });
  const look = 'fd-riso'; // light: its paper is nothing like the default look's dark panel
  const defaultPanel = 'rgb(26, 29, 36)'; // --panel of the default look (styles.css)
  await pickTheme(page, look); // for Room, the top one: the page's look
  await expect(page.locator('html')).toHaveAttribute('data-theme', look);
  await expect(box('Other')).toHaveClass(/\bfolded\b/);
  await expect(box('Other').locator('button.room-more')).toHaveCount(0);
  // Other open on screen, not on top: its ⋯ and its menu in its own look (the default), the way to the top first in it;
  // Room folded, no ⋯
  await alice.selectRoom('Other');
  await expect(box(crowd.room.name).locator('button.room-more')).toHaveCount(0);
  await box('Other').locator('button.room-more').click();
  const menu = box('Other').locator('.room-menu:popover-open');
  await expect(menu).toHaveCSS('background-color', defaultPanel);
  await expect(menu.locator('button.link').first()).toHaveText('Put on top');
  await expect(menu.locator('button.link').first()).toBeEnabled();
  // Its themes card too, and the card wears a look picked there at once, the page still the top room's
  await menu.getByRole('button', { name: 'Themes', exact: true }).click();
  const card = page.locator('.themes:popover-open');
  await expect(card).toHaveCSS('background-color', defaultPanel);
  await card.locator(`.theme-choice[data-theme-name="${look}"]`).click();
  await expect(card).not.toHaveCSS('background-color', defaultPanel);
  await card.locator('.theme-choice[data-theme-name=""]').click();
  await expect(card).toHaveCSS('background-color', defaultPanel);
  await expect(page.locator('html')).toHaveAttribute('data-theme', look);
  await page.keyboard.press('Escape');
  await expect(page.locator('.themes')).toBeHidden();
  // A profile card from Other's lists in Other's look; from Room's, the page's
  await box('Other').locator('.plist .who', { hasText: '(you)' }).click();
  await expect(page.locator('.profile:popover-open')).toHaveCSS('background-color', defaultPanel);
  await page.keyboard.press('Escape');
  await expect(page.locator('.profile')).toBeHidden();
  await alice.selectRoom(crowd.room.name);
  await box(crowd.room.name).locator('.plist .who', { hasText: '(you)' }).click();
  await expect(page.locator('.profile:popover-open')).not.toHaveCSS('background-color', defaultPanel);
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
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect.poll(() => pickedTheme(page)).toBe('');

  const themes = (await themeNames(page)).filter(Boolean);
  const kept = themes[0]!;
  await pickTheme(page, kept);
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  // Its fonts first: a reload cuts off a font still downloading, and Firefox logs that as an error (NS_BINDING_ABORTED).
  await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; });
  await page.reload();
  await alice.connected();
  await expect(page.locator('html')).toHaveAttribute('data-theme', kept);
  await expect.poll(() => pickedTheme(page)).toBe(kept);
});

test('the look picked before rooms had their own stays its room\'s, and a room joined later starts in the default look', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { connect: false });
  const old = 'fd-walkie'; // picked in the ⚙ menu of before
  await alice.context.addInitScript((name) => {
    if (localStorage.getItem('dave.e2e-theme-seeded')) return;
    localStorage.setItem('dave.e2e-theme-seeded', '1');
    localStorage.setItem('dave.theme', name);
  }, old);
  await alice.open();
  const page = alice.page;
  await expect(page.locator('html')).toHaveAttribute('data-theme', old); // nobody's look changes on the update
  // There is no picker left for the old look: a room new to this browser does not wear it.
  const fresh = { secret: newSecret(), name: 'Fresh' };
  await page.goto(`/#${fresh.secret}/${fresh.name}`);
  await alice.connected();
  const box = (name: string) => page.locator('aside.side section.room', { has: page.locator('.room-title', { hasText: name }) });
  await expect(box('Fresh')).toHaveAttribute('data-theme', 'default');
  await expect(box(crowd.room.name)).toHaveAttribute('data-theme', old);
  await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; }); // a reload must not cut off a font download
  await page.reload();
  await alice.connected();
  await expect(box('Fresh')).toHaveAttribute('data-theme', 'default');
  await expect(box(crowd.room.name)).toHaveAttribute('data-theme', old);
});

test('a look picked in a second tab stays when the first tab takes the app back, and a pick there keeps it', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const [look, next] = (await themeNames(alice.page)).filter(Boolean);
  const box = (page: Page, name: string) => page.locator('aside.side section.room', { has: page.locator('.room-title', { hasText: name }) });
  // A link tapped elsewhere opens a second tab; Alice uses dave there and picks a look for the top room.
  const second = await alice.context.newPage();
  alice.watch(second);
  await second.goto('/');
  await second.getByRole('button', { name: 'Use it here instead' }).click();
  await expect(second.locator('.chat-field > input')).toBeEnabled();
  await pickTheme(second, look!);
  await expect(box(second, crowd.room.name)).toHaveAttribute('data-theme', look!);
  // Back in the first tab, which takes the app back without a reload: the look is there too.
  await alice.page.getByRole('button', { name: 'Use it here instead' }).click();
  await alice.connected();
  await expect(alice.page.locator('html')).toHaveAttribute('data-theme', look!);
  await expect(box(alice.page, crowd.room.name)).toHaveAttribute('data-theme', look!);
  // A pick for the other room there does not undo the one made in the second tab.
  await alice.selectRoom('Other');
  await pickTheme(alice.page, next!);
  await expect(box(alice.page, 'Other')).toHaveAttribute('data-theme', next!);
  await second.close();
  await alice.page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await document.fonts.ready; }); // a reload must not cut off a font download
  await alice.page.reload();
  await alice.connected();
  await expect(box(alice.page, crowd.room.name)).toHaveAttribute('data-theme', look!);
  await expect(box(alice.page, 'Other')).toHaveAttribute('data-theme', next!);
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
  await pickTheme(page, theme);
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

// The test above photographs every theme while Bob shares, so a theme whose background goes dark under a share (Kino's
// house lights) is never seen lit there. Read from the computed style: a gradient the engine cannot compute (a typo, or
// a colour syntax one engine does not take) reads as `none` without a word on the console.
test('Kino\'s house lights are on with nobody sharing, go down under a share and come up when it ends', async ({ crowd }) => {
  const room = { secret: newSecret(), name: 'Friday night' };
  const alice = await crowd.open('Alice', { rooms: [room], viewport: DESKTOP });
  // Bob shares his screen, which only Chromium's fake capture does without a picker (share.spec.ts).
  const bob = await crowd.open('Bob', { rooms: [room], engine: 'chromium' });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  const page = alice.page;
  await pickTheme(page, 'imp-kino');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'imp-kino');
  const ambient = page.locator('.ambient');
  const lit = () => ambient.evaluate((el) => ({
    shown: getComputedStyle(el).display,
    glows: [...el.children].slice(0, 5).filter((i) => getComputedStyle(i).backgroundImage.startsWith('radial-gradient')).length,
    grain: getComputedStyle(el, '::after').backgroundImage.startsWith('url('),
  }));
  const on = { shown: 'block', glows: 5, grain: true };
  await expect.poll(lit, { message: 'the house lights are on: five glows and the grain' }).toEqual(on);
  expect(await endless(page), 'the glows stand still with reduced motion').toEqual([]);

  await bob.startShare();
  await expect(ambient, 'the house goes dark under the stage').toBeHidden();
  await bob.stopShare();
  await expect.poll(lit, { message: 'the lights come up again when the share ends' }).toEqual(on);
  expect(await endless(page), 'and still stand still with reduced motion').toEqual([]);
});

// The invite panel and the rows below it: a row hovered lays its ground 4px past its edges (styles.css, `.who:hover`), so
// with nothing between them a friend's row hovered under the panel ran into its border, in every theme (report of Oct 30).
test('the invite panel stands clear of the rows below it, in every theme', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { viewport: DESKTOP });
  const page = alice.page;
  await openRoomMenu(page);
  await page.locator('.room-menu:popover-open').getByRole('button', { name: 'Invite', exact: true }).click();
  const panel = page.locator('.panel.invite');
  await expect(panel).toBeVisible();
  const gap = () => panel.evaluate((el) => el.nextElementSibling!.getBoundingClientRect().top - el.getBoundingClientRect().bottom);
  const themes = await themeNames(page);
  expect(themes.length, 'the picker offers the default look and at least one theme').toBeGreaterThan(1);
  const gaps: Record<string, number> = {};
  for (const value of themes) {
    await pickTheme(page, value);
    await expect(panel).toBeVisible();
    gaps[value || 'default'] = await gap();
  }
  const tight = Object.entries(gaps).filter(([, px]) => px < 8);
  expect(tight, 'themes whose invite panel has less than 8px below it, more than a hovered row\'s 4px').toEqual([]);
});
