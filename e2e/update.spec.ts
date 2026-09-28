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
/** The versions this browser has cached, oldest first: `before` the deploy, and the `next` one it staged. */
const versions = async (page: Page) => (await page.evaluate(() => caches.keys())).map((k) => (k.endsWith('-next') ? 'next' : 'before'));
/** A deploy, as the browser sees it: /sw.js is now a later build, and the check the app makes every few minutes is asked for now. */
const deploy = async (friend: Friend, tag: string) => {
  await cookie(friend, 'e2e-deploy', tag);
  await friend.page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
};
const bar = (page: Page) => page.locator('.update');
/** Clicks the bar's Reload and waits for the page it loads. */
const reloadFromBar = async (page: Page) => { await Promise.all([page.waitForEvent('load'), bar(page).getByRole('button', { name: 'Reload' }).click()]); };

test('ticket 33: a new version waits behind a bar that stays until Reload, which moves the tab onto it and back into the call', async ({ crowd }) => {
  needPreview();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await controlled(alice.page);
  await expect(bar(alice.page), 'the first install is no update').toHaveCount(0);
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  await deploy(alice, 'next');
  await expect(bar(alice.page)).toHaveText(/A new version of dave is ready\.\s*Reload/);
  await expect(bar(alice.page).getByRole('button'), 'nothing to close it with').toHaveCount(1);
  expect(await versions(alice.page), 'the new version installed into a cache of its own, beside the running one').toEqual(['before', 'next']);

  // A reload of her own is not the update: the running version answers it, and the bar is back.
  await alice.page.reload();
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible();
  await expect(bar(alice.page)).toBeVisible();
  expect(await versions(alice.page)).toEqual(['before', 'next']);

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
