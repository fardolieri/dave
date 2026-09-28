import type { Page, Route } from '@playwright/test';
import { expect, needHooks, test } from './fixtures';

// The service worker and the update bar (ticket 33). A new version installs beside the running one and waits; the bar
// stays until its Reload, which moves that tab onto it and no other.

const controlled = (page: Page) => expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: 'a service worker serves the page' }).toBe(true);
const script = (page: Page) => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '');
/** A deploy as the browser sees it (client/update.ts): the same worker under another script URL is a new version. */
const deploy = (page: Page, tag: string) => page.evaluate((t) => (window as unknown as { __daveNextDeploy: (tag: string) => Promise<unknown> }).__daveNextDeploy(t), tag);
const bar = (page: Page) => page.locator('.update');
/** Clicks the bar's Reload and waits for the page it loads. */
const reloadFromBar = async (page: Page) => { await Promise.all([page.waitForEvent('load'), bar(page).getByRole('button', { name: 'Reload' }).click()]); };

test('ticket 33: a new version waits behind a bar that stays until Reload, which moves the tab onto it and back into the call', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await needHooks(alice);
  await controlled(alice.page);
  await expect(bar(alice.page), 'the first install is no update').toHaveCount(0);
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');

  await deploy(alice.page, 'next');
  await expect(bar(alice.page)).toHaveText(/A new version of dave is ready\.\s*Reload/);
  await expect(bar(alice.page).getByRole('button'), 'nothing to close it with').toHaveCount(1);

  // A reload of her own is not the update: the running version answers it, and the bar is back.
  await alice.page.reload();
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible();
  await expect(bar(alice.page)).toBeVisible();
  expect(await script(alice.page)).not.toContain('deploy=next');

  await reloadFromBar(alice.page);
  await alice.connected();
  expect(await script(alice.page)).toContain('deploy=next');
  await expect(bar(alice.page)).toHaveCount(0);
  await expect(alice.button('Leave'), 'rejoined (ticket 24)').toBeVisible();
  await alice.connectedTo('Bob');
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);
});

test('ticket 33: Reload moves only its own tab; a tab waiting behind it is asked once it takes over', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await needHooks(alice);
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

  await deploy(alice.page, 'next');
  await expect(bar(alice.page)).toBeVisible();
  await second.evaluate(() => { (window as unknown as { __stayed: boolean }).__stayed = true; });

  // Reloading both at once would race them for the tab lock; only the tab that was clicked reloads, and it keeps the app and the call.
  await reloadFromBar(alice.page);
  await alice.connected();
  await expect(alice.button('Leave')).toBeVisible();
  await alice.connectedTo('Bob');
  await expect(bar(alice.page)).toHaveCount(0);
  await expect(notice(second)).toBeVisible();
  await expect(bar(second), 'a waiting tab is not asked').toHaveCount(0);
  expect(await second.evaluate(() => (window as unknown as { __stayed?: boolean }).__stayed), 'the other tab did not reload').toBe(true);
  await expect.poll(() => bob.inCall()).toEqual(['Bob', 'Alice']);

  // The second takes over, still on the version before, and asks; its Reload loads the new one.
  await second.getByRole('button', { name: 'Use it here instead' }).click();
  await expect(second.locator('aside.side')).toBeVisible();
  await expect(bar(alice.page), 'the tab it took over from waits').toHaveCount(0);
  await expect(bar(second)).toBeVisible();
  expect(await script(second)).toContain('deploy=next'); // served by the new worker, still running the old page
  await reloadFromBar(second);
  await expect(second.locator('aside.side')).toBeVisible();
  await expect(bar(second)).toHaveCount(0);
});

test('ticket 33: with the server gone the app still opens, from the service worker', async ({ crowd, baseURL }) => {
  const alice = await crowd.open('Alice');
  await controlled(alice.page);
  await alice.say('before the outage');
  // A line is kept once the server sends it back (client/history.ts); on a deployed copy that takes a moment.
  await expect(alice.page.locator('.msg-text', { hasText: 'before the outage' })).toBeVisible();

  // Every request that reaches the network fails, and the socket with it: a page that loads came from the service worker.
  // (Not setOffline: Firefox's offline mode refuses the navigation before a service worker is asked.)
  const failed: string[] = [];
  const down = (r: Route) => { failed.push(r.request().url()); return r.abort('connectionrefused'); };
  const server = (url: URL) => url.origin === new URL(baseURL!).origin;
  await alice.context.route(server, down);
  await alice.wire.cut();
  alice.expectWarning(/Failed to load resource|NS_ERROR_CONNECTION_REFUSED/);
  await alice.page.reload();
  await expect(alice.page.locator('aside.side')).toBeVisible();
  await expect(alice.page.locator('.msg-text', { hasText: 'before the outage' })).toBeVisible();
  await expect(alice.banner).toBeVisible(); // connecting, or the server unavailable

  expect(failed, 'nothing of the app came from the network').toEqual([]);

  await alice.context.unroute(server, down);
  alice.wire.restore();
  await alice.connected();
});
