import type { Route } from '@playwright/test';
import { expect, test, type Friend } from './fixtures';

// YouTube links (core/youtube.ts): a link put into the composer waits there as its video's card, YouTube's thumbnail
// sent as a picture. Friends see the card above the text, and its player only once they press play. YouTube itself is
// stood in for by routes: the tests never reach it.

const ID = 'rFZHOHl-L8A';
const LINK = `https://www.youtube.com/watch?v=${ID}`;
const TITLE = 'lofi hip hop radio 📚 beats to relax/study to';
const CORS = { 'access-control-allow-origin': '*' };

/** A JPEG of `width` by `height` in stripes, as the page's canvas writes one: a thumbnail as YouTube serves it. */
const jpeg = (f: Friend, width: number, height: number): Promise<Buffer> => f.page.evaluate(async ([w, h]) => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  for (let x = 0; x < w; x += 40) { g.fillStyle = x % 80 ? '#e62117' : '#2a7de1'; g.fillRect(x, 0, 40, h); }
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.8));
  return new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve((r.result as string).split(',')[1]!); r.readAsDataURL(blob); });
}, [width, height] as const).then((b64) => Buffer.from(b64, 'base64'));

const serve = (type: string, body: Buffer | string, status = 200) => (r: Route) => r.fulfill({ status, contentType: type, headers: CORS, body });

/** What a friend's log shows, top to bottom: "card" for a YouTube card, the words of each text. */
const order = (f: Friend) => f.page.locator('.chat-log .att-video, .chat-log .msg-text')
  .evaluateAll((els) => els.map((el) => (el.classList.contains('att-video') ? 'card' : el.textContent)));

test('a YouTube link put in waits above the composer as its card, goes above the text, and plays only once pressed', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.context.route(`https://i.ytimg.com/vi/${ID}/maxresdefault.jpg`, serve('image/jpeg', await jpeg(alice, 1280, 720)));
  await alice.context.route('https://www.youtube.com/oembed?**', serve('application/json', JSON.stringify({ title: TITLE, author_name: 'Lofi Girl', html: '<iframe></iframe>' })));
  await bob.context.route('https://www.youtube-nocookie.com/**', serve('text/html', '<!doctype html><title>player</title><p>the player</p>'));
  // Bob's browser asks YouTube for nothing until he presses play: the picture comes from Alice.
  const asked: string[] = [];
  bob.context.on('request', (r) => { if (/(^|\.)(youtube|youtube-nocookie|ytimg)\.com$/.test(new URL(r.url()).hostname)) asked.push(r.url()); });

  await alice.composer.fill(`listen ${LINK}`);
  await expect(alice.staged.locator('.name')).toHaveText(TITLE);
  await expect(alice.staged.locator('.size')).toHaveText('Lofi Girl');
  // Taken off, it is gone. Its link put in again, it is back, once however often the link comes.
  await alice.staged.getByRole('button', { name: /^Remove/ }).click();
  await expect(alice.staged).toHaveCount(0);
  await alice.composer.fill('');
  await alice.composer.fill(`${LINK} and again ${LINK}`);
  await alice.composer.fill(`listen ${LINK}`);
  await expect(alice.staged).toHaveCount(1);
  await expect(alice.staged.locator('.size')).toHaveText('Lofi Girl');
  await expect(alice.sendButton).toBeEnabled();
  await alice.composer.press('Enter');
  await expect(alice.staged).toHaveCount(0);

  for (const f of [alice, bob]) {
    const card = f.page.locator('.chat-log .att-video');
    await expect(card.locator('.title')).toHaveText(TITLE);
    await expect(card.locator('.channel')).toHaveText('Lofi Girl');
    await expect.poll(() => card.locator('img:not(.att-preview)').evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(1280);
    await expect.poll(() => order(f)).toEqual(['card', `listen ${LINK}`]);
  }
  expect(asked).toEqual([]);

  // Firefox knows neither of these permissions the player asks for, which Chromium needs to play it with its sound at once.
  bob.expectWarning(/Feature Policy: Skipping unsupported feature name .(autoplay|encrypted-media)/);
  // The player's own page, YouTube's (a stand-in here): Firefox warns when the check of its text below lays it out before
  // it has loaded, which depends on timing (seen once on PR #140's preview run).
  bob.expectWarning(/Layout was forced before the page was fully loaded.*youtube-nocookie\.com\/embed\//);
  await bob.page.locator('.chat-log .att-video').getByRole('button', { name: `Play ${TITLE}` }).click();
  const player = bob.page.locator('.chat-log .att-video iframe');
  await expect(player).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1`);
  await expect(player.contentFrame().getByText('the player')).toBeVisible();
});

test('a link put in without a paste, as from a phone keyboard\'s clipboard, or typed out, waits as its card too', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  await alice.context.route('https://i.ytimg.com/vi/*/maxresdefault.jpg', serve('image/jpeg', await jpeg(alice, 1280, 720)));
  await alice.context.route('https://www.youtube.com/oembed?**', serve('application/json', JSON.stringify({ title: TITLE, author_name: 'Lofi Girl' })));

  // The text comes in with no paste event: what Gboard's clipboard does, or a link shared from the YouTube app.
  await alice.composer.fill(`https://youtu.be/${ID}?si=AbCd_ef-12`);
  await expect(alice.staged).toHaveCount(1);
  await expect(alice.staged.locator('.size')).toHaveText('Lofi Girl');
  // Taken off, it stays off while its link stays in the text.
  await alice.staged.getByRole('button', { name: /^Remove/ }).click();
  await alice.composer.press('End');
  await alice.composer.pressSequentially(' nice');
  await expect(alice.staged).toHaveCount(0);

  // A phone browser's link, typed out: its card comes once the link is whole. A typo's card goes with the typo.
  await alice.composer.fill('');
  await alice.composer.pressSequentially('https://m.youtube.com/watch?v=dQw4w9WgXcW');
  await expect(alice.staged).toHaveCount(1);
  await alice.composer.press('Backspace');
  await alice.composer.pressSequentially('Q&pp=ygU');
  await expect(alice.staged.locator('.size')).toHaveText('Lofi Girl');
  await expect(alice.staged).toHaveCount(1);
  // The link taken out of the text takes its card along.
  await alice.composer.fill('never mind');
  await expect(alice.staged).toHaveCount(0);
  await alice.sendButton.click();
  await expect(alice.page.locator('.chat-log .att-video')).toHaveCount(0);
});

test('a video with no HD thumbnail goes with the one every video has, and a link YouTube does not answer for goes alone', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  // No HD thumbnail, and no title: YouTube answers 404 to both.
  await alice.context.route(`https://i.ytimg.com/vi/${ID}/maxresdefault.jpg`, serve('image/jpeg', await jpeg(alice, 120, 90), 404));
  await alice.context.route(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, serve('image/jpeg', await jpeg(alice, 480, 360)));
  await alice.context.route('https://www.youtube.com/oembed?**', serve('application/json', 'Not Found', 404));
  // YouTube out of reach for this one.
  await alice.context.route('https://i.ytimg.com/vi/dQw4w9WgXcQ/**', (r) => r.abort('failed'));
  // How each browser says so: Chromium for the 404s and the failed one, Firefox for the failed one.
  alice.expectWarning(/Failed to load resource.*(ytimg|youtube)\.com|Cross-Origin Request Blocked.*i\.ytimg\.com/);

  await alice.composer.fill(LINK);
  await expect(alice.staged.locator('.name')).toHaveText('YouTube video');
  await expect(alice.staged.locator('.size')).toHaveText('YouTube');
  await alice.composer.press('Enter');
  const card = bob.page.locator('.chat-log .att-video');
  await expect.poll(() => card.locator('img:not(.att-preview)').evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(480);
  await expect(card.locator('.att-video-about')).toHaveCount(0);

  await alice.composer.fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(alice.staged).toHaveCount(0); // gone by itself, once YouTube could not be reached
  await alice.composer.press('Enter');
  await expect.poll(() => order(bob)).toEqual(['card', LINK, 'https://youtu.be/dQw4w9WgXcQ']);
});
