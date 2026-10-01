import type { Page } from '@playwright/test';
import { expect, test, type Friend } from '../../../e2e/fixtures';

// The videos of ticket 36. Each scenario records Alice's screen into videos/<name>/.
const out = (name: string) => new URL(`./videos/${name}`, import.meta.url).pathname;
const cookie = (friend: Friend, name: string, value: string) => friend.context.addCookies([{ name, value, url: new URL(friend.page.url()).origin }]);
const controlled = (page: Page) => expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
/** A deploy staged for Alice's next page load; `big`: RNNoise changed too (5.7 MB), at `bytesPerSecond`. */
async function stage(friend: Friend, big: { bytesPerSecond: number } | null) {
  if (big) {
    await friend.page.evaluate(async () => {
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const req of await cache.keys()) if (/rnnoise.*\.wasm$/.test(req.url)) await cache.delete(req);
      }
    });
    await cookie(friend, 'e2e-throttle', String(big.bytesPerSecond));
  }
  await cookie(friend, 'e2e-deploy', 'next');
}
const newVersion = (page: Page) => expect.poll(() => page.evaluate(() => caches.keys()).then((k) => k.length === 1 && k[0]!.endsWith('-next'), () => false), { timeout: 40_000 }).toBe(true);

const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 };

test('1-desktop-big-update-on-open', async ({ crowd }) => {
  const bob = await crowd.open('Bob');
  await bob.join();
  const alice = await crowd.open('Alice', { ...DESKTOP, video: out('1-desktop-big-update-on-open') });
  await controlled(alice.page);
  await stage(alice, { bytesPerSecond: 1_200_000 });
  await pause(alice.page, 1500);
  // Alice opens dave again: a new version is out, with a big file in it.
  await alice.page.goto('/');
  await newVersion(alice.page);
  await alice.connected();
  await pause(alice.page, 2500);
});

test('2-phone-big-update-on-open', async ({ crowd }) => {
  const bob = await crowd.open('Bob');
  await bob.join();
  const alice = await crowd.open('Alice', { ...PHONE, video: out('2-phone-big-update-on-open') });
  await controlled(alice.page);
  await stage(alice, { bytesPerSecond: 1_200_000 });
  await pause(alice.page, 1500);
  await alice.page.goto('/');
  await newVersion(alice.page);
  await alice.connected();
  await pause(alice.page, 2500);
});

test('3-desktop-reload-in-call-rejoins', async ({ crowd }) => {
  const bob = await crowd.open('Bob');
  const alice = await crowd.open('Alice', { ...DESKTOP, video: out('3-desktop-reload-in-call-rejoins') });
  await alice.join();
  await bob.join();
  await alice.connectedTo('Bob');
  await controlled(alice.page);
  await stage(alice, { bytesPerSecond: 1_200_000 });
  await pause(alice.page, 1500);
  await alice.page.reload();
  await newVersion(alice.page);
  await expect(alice.button('Leave')).toBeVisible();
  await alice.connectedTo('Bob');
  await pause(alice.page, 2500);
});

test('4-desktop-typical-small-update', async ({ crowd }) => {
  const bob = await crowd.open('Bob');
  await bob.join();
  const alice = await crowd.open('Alice', { ...DESKTOP, video: out('4-desktop-typical-small-update') });
  await controlled(alice.page);
  await stage(alice, null);
  await pause(alice.page, 1500);
  await alice.page.goto('/');
  await newVersion(alice.page);
  await alice.connected();
  await pause(alice.page, 2500);
});

test('5-desktop-slow-line-gives-up-after-10s', async ({ crowd }) => {
  const bob = await crowd.open('Bob');
  await bob.join();
  const alice = await crowd.open('Alice', { ...DESKTOP, video: out('5-desktop-slow-line-gives-up-after-10s') });
  await controlled(alice.page);
  await stage(alice, { bytesPerSecond: 350_000 });
  await pause(alice.page, 1500);
  await alice.page.goto('/');
  await expect(alice.page.locator('.update'), 'the bar asks once the download is in').toBeVisible({ timeout: 40_000 });
  await pause(alice.page, 2000);
  await alice.page.locator('.update').getByRole('button', { name: 'Reload' }).click();
  await newVersion(alice.page);
  await alice.connected();
  await pause(alice.page, 2000);
});
