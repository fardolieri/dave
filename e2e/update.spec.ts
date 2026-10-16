import type { Page } from '@playwright/test';
import { target } from './browsers';
import { expect, test, type Friend } from './fixtures';

// The service worker and the update bar (ticket 33). A new version installs beside the running one and waits; the bar
// stays until its Reload, which moves that tab onto it and no other.
// A deploy and an outage are staged at the preview server (vite.config.ts, `e2eServer`) through cookies on the friend's
// own context, so these run against a local build only.

const needPreview = () => test.skip(!!target, 'needs the preview server (vite.config.ts): a deploy is staged there, not in a deployed copy');
const cookie = (friend: Friend, name: string, value: string) => friend.context.addCookies([{ name, value, url: new URL(friend.page.url()).origin }]);
const controlled = (page: Page) => expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: 'a service worker serves the page' }).toBe(true);
/** The versions this browser has cached, oldest first: `before` the deploy, and the `next` one it staged. Not the themes' `fonts` (sw.ts). */
const versions = async (page: Page) => (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('dave-')).map((k) => (k.endsWith('-next') ? 'next' : 'before'));
/** A deploy, as the browser sees it: /sw.js is now a later build, and the check the app makes every few minutes is asked for now. */
const deploy = async (friend: Friend, tag: string) => {
  await cookie(friend, 'e2e-deploy', tag);
  await friend.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
};
const bar = (page: Page) => page.locator('.update');
/** The opening update's progress line (ticket 36). */
const line = (page: Page) => page.locator('.update-line');
/**
 * A deploy that changed RNNoise (5.7 MB), staged for the next page load: the file goes from the running version's cache,
 * so the new one has to download it, and every answer of the server trickles at `bytesPerSecond`.
 */
const stageBigDeploy = async (friend: Friend, bytesPerSecond: number) => {
  await friend.page.evaluate(async () => {
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const req of await cache.keys()) if (/rnnoise.*\.wasm$/.test(req.url)) await cache.delete(req);
    }
  });
  await cookie(friend, 'e2e-throttle', String(bytesPerSecond));
  await cookie(friend, 'e2e-deploy', 'next');
};
/** Counts the page loads of `page` from now on. */
const countLoads = (page: Page) => { const n = { loads: 0 }; page.on('load', () => n.loads++); return n; };
/** `versions`, or null while the page is between two loads. */
const versionsNow = (page: Page) => versions(page).catch(() => null);
/** Clicks the bar's Reload and waits for the page it loads. */
const reloadFromBar = async (page: Page) => { await Promise.all([page.waitForEvent('load'), bar(page).getByRole('button', { name: 'Reload' }).click()]); };

test('ticket 33: a new version waits behind a bar that stays until Reload, which moves the tab onto it and back into the call', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await controlled(alice.page);
  await expect(bar(alice.page), 'the first install is no update').toHaveCount(0);
  await expect(line(alice.page), 'and shows no download').toHaveCount(0);
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  await deploy(alice, 'next');
  await expect(bar(alice.page)).toHaveText(/A new version of dave is ready\.\s*Reload/);
  await expect(bar(alice.page).getByRole('button'), 'nothing to close it with').toHaveCount(1);
  expect(await versions(alice.page), 'the new version installed into a cache of its own, beside the running one').toEqual(['before', 'next']);

  await reloadFromBar(alice.page);
  await alice.connected();
  expect(await versions(alice.page), 'the new version took over and deleted the old cache').toEqual(['next']);
  await expect(bar(alice.page)).toHaveCount(0);
  await expect(alice.button('Leave'), 'rejoined (ticket 24)').toBeVisible();
  await alice.connectedTo('Bob');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('ticket 33: Reload moves only its own tab; a tab waiting behind it is asked once it takes over', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  const second = await alice.context.newPage();
  alice.watch(second);
  await second.goto('/');
  const notice = (p: Page) => p.locator('main.notice h2', { hasText: 'already open in another tab' });
  await expect(notice(second)).toBeVisible();
  await controlled(alice.page);
  await controlled(second);

  await deploy(alice, 'next');
  await expect(bar(alice.page)).toBeVisible();
  await expect(bar(second), 'a waiting tab is not asked').toHaveCount(0);
  await second.evaluate(() => { (window as unknown as { __stayed: boolean }).__stayed = true; });

  // Reloading both at once would race them for the tab lock; only the tab that was clicked reloads, and it keeps the app and the call.
  await reloadFromBar(alice.page);
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible();
  await alice.connectedTo('Bob');
  await expect(bar(alice.page)).toHaveCount(0);
  await expect(notice(second)).toBeVisible();
  await expect(bar(second), 'a waiting tab is still not asked').toHaveCount(0);
  expect(await second.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed), 'the other tab did not reload').toBe(true);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);

  // The second takes over, still on the version before, and asks; its Reload loads the new one.
  await second.getByRole('button', { name: 'Use it here instead' }).click();
  await expect(second.locator('aside.side')).toBeVisible();
  await expect(bar(alice.page), 'the tab it took over from waits').toHaveCount(0);
  await expect(bar(second)).toBeVisible();
  expect(await versions(second), 'served by the new worker, its old files gone, still running the old page').toEqual(['next']);
  await reloadFromBar(second);
  await expect(second.locator('aside.side')).toBeVisible();
  await expect(bar(second)).toHaveCount(0);
});

test('ticket 33: with the server gone the app still opens, from the service worker', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);
  await alice.say('before the outage');
  // A line is kept once the server sends it back (client/history.ts); on a deployed copy that takes a moment.
  await expect(alice.page.locator('.msg-text', { hasText: 'before the outage' })).toBeVisible();

  // The server cuts every connection before answering, and the socket goes with it: a page that loads came from the
  // service worker, and a file the worker missed fails it. (Not setOffline: Firefox's offline mode refuses the navigation
  // before a service worker is asked. Not Playwright's routes: a fetch from inside the worker passes them by.)
  await cookie(alice, 'e2e-outage', '1');
  await alice.wire.cut();
  await alice.page.reload();
  await expect(alice.page.locator('aside.side')).toBeVisible();
  await expect(alice.page.locator('.msg-text', { hasText: 'before the outage' })).toBeVisible();
  await expect(alice.banner).toBeVisible(); // connecting, or the server unavailable

  await alice.context.clearCookies({ name: 'e2e-outage' });
  alice.wire.restore();
  await alice.connected();
});

test('ticket 36: a new version found as the app opens downloads behind a line, the rooms not yet connected, and the page reloads onto it and back into the call', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await controlled(alice.page);
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  await stageBigDeploy(alice, 1_500_000);
  const count = countLoads(alice.page);
  await alice.page.reload();
  await expect(line(alice.page), 'the download shows').toBeVisible();
  await expect(alice.button('Join'), 'no Rejoin while it downloads, and no Join').toBeDisabled();
  await expect(alice.composer).toBeDisabled();
  await expect.poll(() => alice.wire.open, { message: 'the room does not connect while it downloads' }).toBe(0);
  expect(await alice.inCall(), 'so no friends show, to be taken away again by the reload').toEqual([]);
  await expect(bar(alice.page), 'nothing to click').toHaveCount(0);
  await expect(line(alice.page)).toBeVisible();
  expect(alice.wire.open, 'still not connected').toBe(0);

  await expect.poll(() => versionsNow(alice.page), { message: 'the page reloaded onto the new version by itself', timeout: 30_000 }).toEqual(['next']);
  await alice.connected();
  expect(count.loads, 'her reload, then the one for the update').toBe(2);
  await expect(line(alice.page)).toHaveCount(0);
  await expect(bar(alice.page)).toHaveCount(0);
  await expect(alice.button('Leave'), 'rejoined (ticket 24)').toBeVisible();
  await alice.connectedTo('Bob');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('ticket 36: a new version the browser is still downloading as the page loads is taken the same way, though registering waits for that download', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);

  // The browser's own check finds the new version before the page asks (Firefox checks as a navigation starts): its
  // install runs, and `register()` in the page loaded meanwhile waits for it to end, past the time the opening check
  // has. Flaky that way in Firefox for the test above (ticket 44, 1 in 80); staged here for sure: the check starts in
  // the page before, and the reload comes while the download, about 6 s at 1 MB/s, goes on.
  await stageBigDeploy(alice, 1_000_000);
  await alice.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  await expect(line(alice.page), 'downloading').toBeVisible();
  const count = countLoads(alice.page);
  await alice.page.reload();
  await expect(line(alice.page), 'the download shows after the reload too').toBeVisible();
  await expect(alice.composer, 'and the app waits for it').toBeDisabled();
  await expect.poll(() => alice.wire.open, { message: 'the room does not connect while it downloads' }).toBe(0);
  await expect(bar(alice.page), 'nothing to click').toHaveCount(0);

  await expect.poll(() => versionsNow(alice.page), { message: 'the page reloaded onto the new version by itself', timeout: 30_000 }).toEqual(['next']);
  await alice.connected();
  expect(count.loads, 'her reload, then the one for the update').toBe(2);
  await expect(line(alice.page)).toHaveCount(0);
  await expect(bar(alice.page)).toHaveCount(0);
});

test('report of 2026-10-16: a new version the browser takes 2.5 s to find as the app opens is still taken, not asked for', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);

  // On a phone, and in Brave restoring its tabs, the check's answer came 2 to 4 s after the page load when there was a
  // new version (the browser starts the new worker before it says so), and the opening had ended at 1.5 s: the bar asked.
  await cookie(alice, 'e2e-sw-delay', '2500');
  await cookie(alice, 'e2e-deploy', 'next');
  const count = countLoads(alice.page);
  await alice.page.reload();

  await expect.poll(() => versionsNow(alice.page), { message: 'the page reloaded onto the new version by itself', timeout: 30_000 }).toEqual(['next']);
  await alice.connected();
  expect(count.loads, 'her reload, then the one for the update').toBe(2);
  await expect(bar(alice.page)).toHaveCount(0);
});

test('report of 2026-10-16: a call left 26 s ago, as when Android killed the browser, is rejoined after an opening update found late', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await controlled(alice.page);
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  // Android kills a background browser without a pagehide: the marker is as old as its last heartbeat (up to 10 s) plus
  // the time to come back. Aged at the first load only; the page the update loads reads what the first one left.
  await alice.page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-aged')) return;
    sessionStorage.setItem('e2e-aged', '1');
    const m = JSON.parse(localStorage.getItem('dave.rejoin') ?? 'null') as { at: number } | null;
    if (m) localStorage.setItem('dave.rejoin', JSON.stringify({ ...m, at: Date.now() - 26_000 }));
  });
  // Found about 2.6 s in, downloaded in about 3 s: taken within the 10 s freeze, past the marker's 30 s.
  await cookie(alice, 'e2e-sw-delay', '2500');
  await stageBigDeploy(alice, 2_000_000);
  const count = countLoads(alice.page);
  await alice.page.reload();

  await expect.poll(() => versionsNow(alice.page), { message: 'taken by itself', timeout: 30_000 }).toEqual(['next']);
  await alice.connected();
  expect(count.loads, 'her reload, then the one for the update').toBe(2);
  await expect(alice.button('Leave'), 'rejoined: the page that held the app passed the marker on').toBeVisible();
  await alice.connectedTo('Bob');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('report of 2026-10-16: an opening check with no answer holds the app 5 s at most, and the new version it brings later asks, never reloads', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);

  // Flaky Wi-Fi: /sw.js answers 12 s late, past both the opening check and the 10 s freeze.
  await cookie(alice, 'e2e-sw-delay', '12000');
  await cookie(alice, 'e2e-deploy', 'next');
  const count = countLoads(alice.page);
  const reloaded = Date.now();
  await alice.page.reload();
  await alice.connected(9_000);
  expect(Date.now() - reloaded, 'the opening check gave up at 5 s, not at the 10 s freeze').toBeLessThan(9_000);

  await alice.say('typed while the answer is still out');
  await expect(bar(alice.page), 'the late answer asks').toBeVisible({ timeout: 30_000 });
  expect(count.loads, 'and the page did not reload under her').toBe(1);
  await expect(alice.page.locator('.msg-text', { hasText: 'typed while the answer is still out' })).toBeVisible();
});

test('ticket 44: a register() that fails holds nothing, and a new version is still taken through the registration the page has', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);
  // Storage in a bad state, an add-on, an old Firefox for Android: the page is served, but registering again fails.
  alice.expectWarning(/service worker not registered/);
  await alice.page.addInitScript(() => {
    ServiceWorkerContainer.prototype.register = () => Promise.reject(new Error('flaky'));
  });

  await alice.page.reload();
  await alice.connected(); // nothing new: the opening ends, the composer is not left disabled
  await expect(line(alice.page)).toHaveCount(0);
  await expect(bar(alice.page)).toHaveCount(0);

  await stageBigDeploy(alice, 1_500_000);
  const count = countLoads(alice.page);
  await alice.page.reload();
  await expect(line(alice.page), 'found through the registration the page has').toBeVisible();
  await expect(alice.composer).toBeDisabled();
  await expect.poll(() => versionsNow(alice.page), { message: 'taken by itself', timeout: 30_000 }).toEqual(['next']);
  await alice.connected();
  expect(count.loads, 'her reload, then the one for the update').toBe(2);
  await expect(bar(alice.page)).toHaveCount(0);
});

test('ticket 44: a second tab opened while the first downloads waits behind it with no line, and only the first is asked', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);
  const count = countLoads(alice.page);

  await stageBigDeploy(alice, 1_000_000);
  await alice.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  await expect(line(alice.page)).toBeVisible();

  // The second tab finds the download under way as it opens, but the tab lock puts it behind the first.
  const second = await alice.context.newPage();
  alice.watch(second);
  await second.goto('/');
  const notice = (p: Page) => p.locator('main.notice h2', { hasText: 'already open in another tab' });
  await expect(notice(second)).toBeVisible();
  await second.evaluate(() => { (window as unknown as { __stayed: boolean }).__stayed = true; });
  await expect(line(second), 'a waiting tab shows no line').toHaveCount(0);
  await expect(alice.composer, 'the first is not frozen by it').toBeEnabled();

  await expect(bar(alice.page), 'once it is in, the first asks').toBeVisible({ timeout: 30_000 });
  await expect(bar(second), 'a waiting tab is not asked').toHaveCount(0);
  await expect(line(second)).toHaveCount(0);
  expect(count.loads, 'the first did not reload').toBe(0);
  expect(await second.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed), 'nor the second').toBe(true);
});

test('ticket 36: a version left waiting behind the bar is taken by the next reload', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);
  await deploy(alice, 'next');
  await expect(bar(alice.page)).toBeVisible();

  // Both engines answer the reload from the running version, whose opening check takes the waiting one and loads again:
  // Chromium after its 1 s fallback, Firefox at the controllerchange 100 to 300 ms in (counted 2026-10-09, 40 runs each).
  // Flaky in Firefox until then, 3 in 40 (run 37887013263): that second reload cut off PostHog's SDK while the page still
  // imported it, and Firefox warned twice of a module that failed to load. A page that takes the update loads no PostHog now.
  await alice.page.reload();
  await expect.poll(() => versionsNow(alice.page), { message: 'the reload ended on the new version' }).toEqual(['next']);
  await alice.connected();
  await expect(bar(alice.page)).toHaveCount(0);
  await expect(line(alice.page)).toHaveCount(0);
});

test('ticket 36: a download past 10 s unfreezes the app on the version it has, the line goes on, and the bar asks once it is in', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);

  // RNNoise at 200 kB/s takes about 28 s: past the 10 s unfreeze and the connect after it with room to spare. At
  // 350 kB/s (16 s) a slow runner's connect left the download done before the line was looked for (PR #72, 2026-10-16).
  await stageBigDeploy(alice, 200_000);
  const count = countLoads(alice.page);
  const reloaded = Date.now();
  await alice.page.reload();
  await expect(line(alice.page)).toBeVisible();
  await expect(alice.button('Join')).toBeDisabled();
  await expect(alice.button('Join'), 'unfrozen after 10 s').toBeEnabled({ timeout: 20_000 });
  expect(Date.now() - reloaded, 'not before').toBeGreaterThan(9_000);
  await alice.connected();
  await expect(line(alice.page), 'the download goes on, and shows').toBeVisible();

  await expect(bar(alice.page), 'once it is in, the bar asks').toBeVisible({ timeout: 40_000 });
  await expect(line(alice.page)).toHaveCount(0);
  expect(count.loads, 'no reload of its own').toBe(1);
  expect(await versions(alice.page)).toEqual(['before', 'next']);
  await reloadFromBar(alice.page);
  await alice.connected();
  expect(await versions(alice.page)).toEqual(['next']);
});

test('ticket 36: a new version found by a later check shows its download as the line too, the app not frozen, then the bar', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  await controlled(alice.page);
  const count = countLoads(alice.page);

  await stageBigDeploy(alice, 1_500_000);
  await alice.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  await expect(line(alice.page)).toBeVisible();
  await expect(alice.composer, 'nothing waits for it').toBeEnabled();
  await expect(alice.button('Join')).toBeEnabled();
  await expect(bar(alice.page)).toHaveCount(0);

  await expect(bar(alice.page), 'once it is in, the bar asks').toBeVisible({ timeout: 30_000 });
  await expect(line(alice.page)).toHaveCount(0);
  expect(count.loads, 'no reload of its own').toBe(0);
});
