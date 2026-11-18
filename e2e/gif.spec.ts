import type { Route } from '@playwright/test';
import { expect, test, type Friend } from './fixtures';

// `/gif rick roll` (core/gif.ts): the first GIF Tenor finds goes after the text as a picture, as `/yt` sends a video's
// card (youtube.spec.ts). Our Worker's search and Tenor's media are stood in for by routes: the tests never reach Tenor.

const GIF = 'https://media.tenor.com/x8v1oNUOmg4AAAAx/rickroll-roll.webp';
const CORS = { 'access-control-allow-origin': '*' };

/** A WebP of `width` by `height` in stripes, as the page's canvas writes one: a GIF as Tenor serves it, animated or not. */
const webp = (f: Friend, width: number, height: number): Promise<Buffer> => f.page.evaluate(async ([w, h]) => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  for (let x = 0; x < w; x += 20) { g.fillStyle = x % 40 ? '#f5a623' : '#7b1fa2'; g.fillRect(x, 0, 20, h); }
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/webp', 0.8));
  return new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve((r.result as string).split(',')[1]!); r.readAsDataURL(blob); });
}, [width, height] as const).then((b64) => Buffer.from(b64, 'base64'));

const serve = (type: string, body: Buffer | string, status = 200) => (r: Route) => r.fulfill({ status, contentType: type, headers: CORS, body });

/** What a friend's log shows, top to bottom: "picture" for a picture, the words of each text. */
const order = (f: Friend) => f.page.locator('.chat:not(.private) .chat-log .att-media, .chat:not(.private) .chat-log .msg-text')
  .evaluateAll((els) => els.map((el) => (el.classList.contains('att-media') ? 'picture' : el.textContent)));

test('/gif sends as it is, says it is rolling, then the first GIF Tenor finds for it comes as a picture; none found, the sender alone is told', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.context.route(GIF, serve('image/webp', await webp(alice, 320, 240)));
  // Bob's browser asks Tenor for nothing: the picture comes from Alice.
  const asked: string[] = [];
  bob.context.on('request', (r) => { const u = new URL(r.url()); if (/(^|\.)tenor\.com$/.test(u.hostname) || u.pathname === '/gif-search') asked.push(r.url()); });
  const searched: string[] = [];
  let answer: (search: string) => unknown = () => ({ url: GIF });
  let answerFirst = () => {};
  const first = new Promise<void>((done) => { answerFirst = done; });
  await alice.context.route('**/gif-search', async (r) => {
    const q = r.request().postData()!;
    searched.push(q);
    if (q === 'rick roll') await first;
    return serve('application/json', JSON.stringify(answer(q)))(r);
  });

  // Nothing waits above the composer: what comes is a surprise.
  await alice.composer.fill('/gif rick  roll');
  await expect(alice.sendButton).toBeEnabled();
  await alice.composer.press('Enter');
  await expect(alice.staged).toHaveCount(0);
  for (const f of [alice, bob]) await expect(f.page.locator('.chat-log .msg', { hasText: '/gif rick  roll' }).locator('.msg-roll')).toHaveText('🎲 rolling…');
  answerFirst();
  for (const f of [alice, bob]) {
    const shown = f.page.locator('.chat-log .att-media img:not(.att-preview)');
    await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(320);
    await expect.poll(() => order(f)).toEqual(['/gif rick  roll', 'picture']);
    await expect(f.page.locator('.chat-log .msg-roll')).toHaveCount(0);
  }
  expect(searched).toEqual(['rick roll']);
  expect(asked).toEqual([]);

  // None found, and one Tenor did not hand over: Alice alone is told which, and her rolling stops with it.
  answer = (q) => (q === 'zzzz' ? { error: 'none' } : { url: 'https://media.tenor.com/gone0000000AAAAx/gone.webp' });
  await alice.context.route('https://media.tenor.com/gone0000000AAAAx/gone.webp', serve('text/plain', 'Not Found', 404));
  alice.expectWarning(/Failed to load resource: the server responded with a status of 404.*media\.tenor\.com\/gone/);
  await alice.composer.fill('/gif zzzz');
  await alice.composer.press('Enter');
  await alice.composer.fill('/gif gone');
  await alice.composer.press('Enter');
  await expect.poll(() => alice.page.locator('.chat-log .msg-sys .msg-text').allTextContents())
    .toEqual(['No GIF sent: Tenor found none for “zzzz”.', 'No GIF sent: Tenor did not answer.']);
  await expect(alice.page.locator('.chat-log .msg-roll')).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(() => order(bob)).toEqual(['/gif rick  roll', 'picture', '/gif zzzz', '/gif gone']);
  await expect(bob.page.locator('.chat-log .msg-sys', { hasText: 'No GIF sent' })).toHaveCount(0);
});
