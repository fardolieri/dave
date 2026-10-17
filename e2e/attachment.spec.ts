import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, needHooks, newSecret, test, type Friend } from './fixtures';

// Attachments (ADR 0006): the announcement goes sealed through the Room, the bytes from friend to friend over a file
// link. Bob stays a visitor throughout: file links do not need the call.

/** A real PNG, `width` by `height`, in stripes, so the browser has something to decode and the bytes are known. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set(x % 8 < 4 ? [108, 140, 255] : [245, 182, 66], y * (1 + width * 3) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** The SHA-256 of what a blob URL on the page holds, as the page reads it. */
const pageHash = (url: string) => async (u: string) => {
  const bytes = await (await fetch(u)).arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
};

test('a picture reaches a friend who is not in the call, inline, with the same bytes', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const picture = png(640, 480);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: picture });

  // Alice sees her own at once; Bob pulls it from her by himself.
  for (const f of [alice, bob]) {
    const shown = f.page.locator('.chat-log .att-media img:not(.att-preview)');
    await expect(shown).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
    const url = await shown.getAttribute('src');
    expect(url).toMatch(/^blob:/);
    expect(await f.page.evaluate(pageHash(url!), url!)).toBe(sha256(picture));
  }
  await expect(bob.page.locator('.chat-log .msg-from')).toHaveText(['Alice']);
  // The full size opens on a click, and closes on one.
  await bob.page.locator('.chat-log .att-media img').click();
  await expect(bob.page.locator('dialog.viewer img')).toBeVisible();
  await bob.page.locator('dialog.viewer').click();
  await expect(bob.page.locator('dialog.viewer')).not.toBeVisible();
});

test('regression: a line under a name shows its time over the text or the picture, not over the empty space beside it', async ({ crowd }) => {
  // Oct 2026: the time was the title of the whole row, so it came up anywhere to the right of a short line or a picture.
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.say('one');
  await alice.say('two');
  await expect.poll(() => bob.chatTexts()).toEqual(['one', 'two']);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: png(64, 48) });
  await expect(bob.page.locator('.chat-log .att-media img:not(.att-preview)')).toHaveCount(1, { timeout: 30_000 });

  const rows = bob.page.locator('.chat-log .msg-cont');
  await expect(rows).toHaveCount(2); // "two" and the picture, both under Alice's name
  // The tooltip the browser would show at a point: the title of the nearest element there that has one.
  const tips = (row: number) => rows.nth(row).evaluate((el) => {
    const tip = (x: number, y: number) => document.elementFromPoint(x, y)?.closest('[title]')?.getAttribute('title') ?? null;
    const r = el.getBoundingClientRect();
    const c = el.firstElementChild!.getBoundingClientRect();
    return { over: tip(c.left + 2, c.top + c.height / 2), beside: tip(r.right - 4, c.top + c.height / 2) };
  });
  await rows.nth(1).scrollIntoViewIfNeeded();
  const text = await tips(0);
  expect(text.over).toMatch(/\d/);
  expect(text.beside).toBeNull();
  const picture = await tips(1);
  expect(picture.over).toMatch(/^stripes\.png, .*\d/); // its name, and its time
  expect(picture.beside).toBeNull();
});

/**
 * A real GIF, `side` pixels square, that loops through two frames: red, then blue, a tenth of a second each. Each frame is
 * one colour in 3-bit LZW codes, a clear code before every two pixels, so the code size never grows.
 */
function gif(side: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(side, 0);
  screen.writeUInt16LE(side, 2);
  screen[4] = 0x80; // a global colour table of two colours
  const loop = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const frame = (colour: number) => {
    const codes: number[] = [];
    for (let i = 0; i < side * side; i++) { if (i % 2 === 0) codes.push(4); codes.push(colour); }
    codes.push(5);
    const packed: number[] = [];
    codes.forEach((c, i) => { for (let b = 0; b < 3; b++) { const bit = i * 3 + b; packed[bit >> 3] = (packed[bit >> 3] ?? 0) | (((c >> b) & 1) << (bit & 7)); } });
    const blocks: number[] = [];
    for (let i = 0; i < packed.length; i += 255) { const part = packed.slice(i, i + 255); blocks.push(part.length, ...part); }
    const place = Buffer.alloc(10);
    place[0] = 0x2c;
    place.writeUInt16LE(side, 5);
    place.writeUInt16LE(side, 7);
    return Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, ...place, 0x02, ...blocks, 0x00]);
  };
  return Buffer.concat([Buffer.from('GIF89a', 'ascii'), screen, Buffer.from([255, 0, 0, 0, 0, 255]), loop, frame(0), frame(1), Buffer.from([0x3b])]);
}

test('a GIF holds still while the window is not focused, and moves again when it is', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.page.getByTestId('attach').setInputFiles({ name: 'blink.gif', mimeType: 'image/gif', buffer: gif(32) });
  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(32);
  const still = bob.page.locator('.chat-log .att-media canvas.still');
  // What the app reads for focus (hasFocus, the focus and blur events); the window itself is not moved.
  const focus = (on: boolean) => bob.page.evaluate((on) => {
    document.hasFocus = () => on;
    window.dispatchEvent(new Event(on ? 'focus' : 'blur'));
  }, on);
  await focus(true);
  await expect(still).toHaveCount(0);
  await expect(shown).toHaveCSS('opacity', '1');

  await focus(false);
  await expect(still).toBeVisible();
  await expect(shown).toHaveCSS('opacity', '0');
  // The still is a frame of the GIF, not an empty box: red or blue, whole.
  const middle = await still.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data));
  expect([[255, 0, 0, 255], [0, 0, 255, 255]]).toContainEqual(middle);
  // The picture under it still takes the click, and opens full size.
  await shown.click();
  await expect(bob.page.locator('dialog.viewer img')).toBeVisible();
  await expect(bob.page.locator('dialog.viewer canvas.still')).toBeVisible();
  await bob.page.locator('dialog.viewer').click();

  await focus(true);
  await expect(still).toHaveCount(0);
  await expect(shown).toHaveCSS('opacity', '1');
  // A picture that cannot move gets no still. The window is tall enough for both on screen, so the GIF's still showing
  // again says the blur has been seen.
  await bob.page.setViewportSize({ width: 1280, height: 1600 });
  await alice.page.getByTestId('attach').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: png(64, 48) });
  const stripes = bob.page.locator('.chat-log .att-media').filter({ has: bob.page.locator('img[alt="stripes.png"]') });
  await expect.poll(() => stripes.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(64);
  await focus(false);
  await expect(still).toBeVisible();
  await expect(stripes.locator('img')).toBeInViewport();
  await expect(stripes.locator('img')).toHaveCSS('opacity', '1');
  await expect(stripes.locator('canvas')).toHaveCount(0);
});

test('a GIF that arrives in a window never focused shows held still, a whole frame, and moves once focused', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  // Every load of Bob's page from here on starts without focus, as after a reload on the second screen: no blur ever fires.
  await bob.page.addInitScript(() => { document.hasFocus = () => false; });
  await bob.page.reload();
  await bob.connected();
  await alice.page.getByTestId('attach').setInputFiles({ name: 'blink.gif', mimeType: 'image/gif', buffer: gif(32) });
  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(32);
  const still = bob.page.locator('.chat-log .att-media canvas.still');
  await expect(still).toBeVisible();
  await expect(shown).toHaveCSS('opacity', '0');
  // Drawn once the bytes were there: the GIF's own size, not an empty 300 by 150, and a whole frame.
  expect(await still.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([32, 32]);
  const middle = await still.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(16, 16, 1, 1).data));
  expect([[255, 0, 0, 255], [0, 0, 255, 255]]).toContainEqual(middle);
  await bob.page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
  await expect(still).toHaveCount(0);
  await expect(shown).toHaveCSS('opacity', '1');
});

test('while the window is not focused only a GIF on screen is held still, and one scrolled back to gets a fresh still', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await bob.page.setViewportSize({ width: 1200, height: 500 });
  await alice.page.getByTestId('attach').setInputFiles({ name: 'blink.gif', mimeType: 'image/gif', buffer: gif(32) });
  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(32);
  // Lines until the GIF has left the log: how many that takes is the layout's business, not this test's.
  const onScreen = () => shown.evaluate((img) => new Promise<boolean>((done) => {
    const seen = new IntersectionObserver(([e]) => { seen.disconnect(); done(!!e?.isIntersecting); });
    seen.observe(img);
  }));
  await bob.page.locator('.chat-log').hover();
  for (let i = 0; i < 100 && (await onScreen()); i++) {
    await alice.say(`line ${i}`);
    await bob.page.mouse.wheel(0, 10_000);
  }
  await expect(shown).not.toBeInViewport();
  await bob.page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  const still = bob.page.locator('.chat-log .att-media canvas.still');
  await expect(still).toHaveCount(0); // off screen: no copy made
  await bob.page.mouse.wheel(0, -10_000); // the wheel works over a window without focus
  await expect(shown).toBeInViewport();
  await expect(still).toBeVisible();
  const middle = await still.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data));
  expect([[255, 0, 0, 255], [0, 0, 255, 255]]).toContainEqual(middle);
  await bob.page.mouse.wheel(0, 10_000);
  await expect(still).toHaveCount(0);
});

/** What a site serves behind a picture a browser copies as a still PNG: a GIF that moves. */
const served = gif(8);

/** Pastes into the composer what a browser puts on the clipboard for a copied picture: a PNG, and HTML pointing at its source. */
const pastePicture = (f: Friend, still: Buffer, html: string) => f.composer.evaluate((input, [b64, html]) => {
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
  clipboardData.setData('text/html', html);
  // Set on the event itself: Firefox's constructor ignores `clipboardData` and makes an empty one of its own.
  const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: clipboardData });
  input.dispatchEvent(paste);
}, [still.toString('base64'), html] as const);

test('a GIF pasted from a browser goes as the GIF its site serves, not the still picture the browser copied', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.context.route('https://gifs.example/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', headers: { 'access-control-allow-origin': '*' }, body: served }));
  await pastePicture(alice, png(640, 480), '<meta charset="utf-8"><img src="https://gifs.example/media/dancing%20cat.gif?w=1&amp;h=1" alt="cat">');

  for (const f of [alice, bob]) {
    const shown = f.page.locator('.chat-log .att-media img:not(.att-preview)');
    await expect(shown).toHaveCount(1, { timeout: 30_000 });
    const url = (await shown.getAttribute('src'))!;
    expect(await f.page.evaluate(pageHash(url), url)).toBe(sha256(served));
  }
  await expect(alice.page.locator('.chat-log .att-media img:not(.att-preview)')).toHaveAttribute('alt', /dancing cat\.gif/);
});

test('a GIF still coming from its site when its sender opens another room goes to the room it was pasted in', async ({ crowd }) => {
  const other = { secret: newSecret(), name: 'Other' };
  const alice = await crowd.open('Alice', { rooms: [crowd.room, other] });
  const bob = await crowd.open('Bob');
  await alice.selectRoom(crowd.room.name);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await alice.context.route('https://gifs.example/**', async (r) => { await held; await r.fulfill({ status: 200, contentType: 'image/gif', headers: { 'access-control-allow-origin': '*' }, body: served }); });
  await pastePicture(alice, png(640, 480), '<img src="https://gifs.example/media/cat.gif">');
  await alice.selectRoom('Other');
  release();

  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 30_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(served));
  await expect(alice.page.locator('.chat-log .att-media')).toHaveCount(0); // Other, still open, never had it
});

test('a picture pasted from a site that does not let the page read it goes as the still picture the browser copied', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  // How a fetch the site's CORS refuses ends for the page: a network error, as here.
  await alice.context.route('https://gifs.example/**', (r) => r.abort('failed'));
  alice.expectWarning(/gifs\.example|Failed to load resource/);
  const still = png(640, 480);
  await pastePicture(alice, still, '<img src="https://gifs.example/media/cat.gif">');

  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 30_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(still));
});

test('a file that does not show inline waits for a click, then saves under its own name', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const notes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=1"/>');
  await alice.page.getByTestId('attach').setInputFiles({ name: 'notes.svg', mimeType: 'image/svg+xml', buffer: notes });

  const card = bob.page.locator('.chat-log .att-card');
  await expect(card.locator('.att-name')).toHaveText('notes.svg');
  await expect(card.locator('a.att-save')).toHaveCount(0);
  await card.getByRole('button', { name: /⬇/ }).click();
  const save = card.locator('a.att-save');
  await expect(save).toHaveAttribute('download', 'notes.svg', { timeout: 30_000 });
  const url = (await save.getAttribute('href'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(notes));
  // Never rendered: an SVG is offered as bytes, not as a picture of the app's origin.
  expect(await bob.page.evaluate(async (u) => (await fetch(u)).headers.get('content-type'), url)).toBe('application/octet-stream');
  expect(await bob.page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

/** The same PNG with `bytes` of noise in a private chunk before its end: still a picture, as heavy as a phone photo. */
function heavy(picture: Buffer, bytes: number): Buffer {
  const data = randomBytes(bytes);
  const body = Buffer.concat([Buffer.from('daVe', 'ascii'), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  return Buffer.concat([picture.subarray(0, picture.length - 12), chunk, picture.subarray(picture.length - 12)]); // IEND last
}

test('a pull outlives a blip of the puller\'s socket, and the picture still shows by itself', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  // Alice's uplink stalls after four chunks of a pull (64 KB slices), until let go: a slow line, held still by the test.
  await alice.page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    let chunks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as unknown as { releasePull: () => void }).releasePull = release;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      if (this.size === 64 * 1024 && ++chunks > 4) await gate;
      return read.call(this);
    };
  });
  const picture = heavy(png(640, 480), 2 * 1024 * 1024);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: picture });
  await expect(bob.page.locator('.chat-log .att-media figcaption')).toHaveText(/\b[1-9]\d?% of/, { timeout: 30_000 });

  // Bob's socket drops and comes back, as on a Wi-Fi to mobile handover; the file link between them is not the socket.
  await bob.wire.cut();
  await expect.poll(() => alice.online()).not.toContain('Bob');
  bob.wire.restore();
  await bob.connected();
  await alice.page.evaluate(() => (window as unknown as { releasePull: () => void }).releasePull());

  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(640);
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

test('a picture that could not be pulled while its sender was frozen is pulled once she is back', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  // Alice's tab is in the background: her socket is still there, but nothing she is sent is answered.
  alice.wire.down = (frame) => (frame.includes('"t":"link"') ? null : frame);
  const picture = png(640, 480);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: picture });
  await expect(bob.page.locator('.chat-log .att-media figcaption')).toContainText("Couldn't reach Alice", { timeout: 45_000 });

  // She opens the tab again: the phone had dropped her socket, and she comes back online.
  alice.wire.down = null;
  await alice.wire.cut();
  await expect.poll(() => bob.online()).not.toContain('Alice');
  alice.wire.restore();
  await alice.connected();
  await expect.poll(() => bob.online()).toContain('Alice');

  // Pictures load by themselves (ADR 0006): no click, now that whoever has it is here again.
  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 30_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

test('a file sent again by a second friend comes from her while the first is away', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  const meme = randomBytes(50_000);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'meme.zip', mimeType: 'application/zip', buffer: meme });
  const cards = bob.page.locator('.chat-log .att-card');
  await expect(cards).toHaveCount(1);

  await alice.close();
  await expect.poll(() => bob.online()).not.toContain('Alice');
  await carol.page.getByTestId('attach').setInputFiles({ name: 'meme.zip', mimeType: 'application/zip', buffer: meme });
  await expect(cards).toHaveCount(2);

  // Bob asks for Carol's copy: Carol is online and has it.
  const carols = cards.nth(1);
  await carols.getByRole('button', { name: /⬇/ }).click();
  await expect(carols).not.toContainText('Waiting for Carol');
  const save = carols.locator('a.att-save');
  await expect(save).toHaveAttribute('download', 'meme.zip', { timeout: 30_000 });
  const url = (await save.getAttribute('href'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(meme));
});

// Report of 2026-10-16 (PR #67 preview, Android): "Couldn't reach" a friend, and "Try again" stayed at 0% though she was
// online. The pulls that never connected left their links open on her side for a minute, two per friend at most, so
// every new ask from that friend in that minute went unanswered.
test('regression: a pull tried again after its friend could not be reached is answered', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  // Alice's answers never reach Bob: his pulls do not connect, and give up.
  alice.wire.up = (frame) => (frame.startsWith('{"t":"link"') ? null : frame);
  for (const [i, name] of ['one.png', 'two.png'].entries()) {
    await alice.page.getByTestId('attach').setInputFiles({ name, mimeType: 'image/png', buffer: png(64 + i, 48) });
  }
  const failed = bob.page.locator('.chat-log .att-media figcaption', { hasText: "Couldn't reach Alice" });
  await expect(failed).toHaveCount(2, { timeout: 60_000 });

  // The line is fine again; Bob tries once more, at once.
  alice.wire.up = null;
  await failed.first().getByRole('button', { name: 'Try again' }).click();
  await expect(bob.page.locator('.chat-log .att-media img:not(.att-preview)')).toHaveCount(1, { timeout: 15_000 });
});

/** Every 64 KB slice a holder reads for a pull takes a second: a phone's slow uplink, so pulls stay under way a while. */
const slowUplink = () => {
  const read = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function (this: Blob) {
    if (this.size === 64 * 1024) await new Promise((resolve) => setTimeout(resolve, 1000));
    return read.call(this);
  };
};

// Review of PR #68 (Grumpy Friend), 2026-10-16: a phone's browser kills the tab mid-pull, and its links never say
// goodbye. Alice's two links to Bob were up and busy, so neither counted as given up, and every ask from his reopened
// tab found no place.
test('regression: pictures asked again after the puller\'s tab died mid-pull come, though his old links never closed', async ({ crowd, browserName }) => {
  test.skip(browserName !== 'chromium', 'crashes the renderer through CDP');
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.page.evaluate(slowUplink);
  for (const [i, buffer] of [heavy(png(640, 480), 2 * 1024 * 1024), heavy(png(480, 640), 2 * 1024 * 1024)].entries()) {
    await alice.page.getByTestId('attach').setInputFiles({ name: `big-${i}.png`, mimeType: 'image/png', buffer });
  }
  // Both under way, and kept: the reopened tab finds them in its history and pulls them by itself.
  await expect(bob.page.locator('.chat-log .att-media figcaption', { hasText: /\b[1-9]\d?% of/ })).toHaveCount(2, { timeout: 30_000 });
  await expect.poll(async () => (await bob.storedTexts()).sort()).toEqual(['big-0.png', 'big-1.png']);

  // The tab is killed: nothing goes out, on the socket or on the links. He opens it again at once, same browser.
  const cdp = await bob.context.newCDPSession(bob.page);
  const crashed = bob.page.waitForEvent('crash');
  void cdp.send('Page.crash').catch(() => {});
  await crashed;
  bob.page = await bob.context.newPage();
  bob.watch(bob.page);
  await bob.open();

  await expect(bob.page.locator('.chat-log .att-media img:not(.att-preview)')).toHaveCount(2, { timeout: 120_000 });
});

/** A room's attachment hooks (client/room.ts), in a page that shows one room. */
const files = (f: Friend) => ({
  call: <T>(name: string, ...args: unknown[]) => f.page.evaluate(([n, a]) => {
    const rooms = (window as unknown as { __daveFiles: Record<string, Record<string, (...x: unknown[]) => unknown>> }).__daveFiles;
    return Object.values(rooms)[0]![n as string]!(...(a as unknown[]));
  }, [name, args] as const) as Promise<T>,
  fired: async () => (await files(f).call<Array<{ kind: string }>>('invariants')).map((v) => v.kind),
});

// Attachments ticket 04: the chat never says a file is coming when nothing can bring it. Every other test checks that the
// watchdog stays quiet ([invariant] warnings fail a test); here each invariant is broken on purpose through the hooks.
test('a pull shown under way with none running is reported (file_pulling_stuck)', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await needHooks(bob);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: png(64, 48) });
  await expect(bob.page.locator('.chat-log .att-media img:not(.att-preview)')).toHaveCount(1, { timeout: 30_000 });
  const [hash] = Object.keys(await files(bob).call<Record<string, string>>('attachments'));
  bob.expectInvariant('file_pulling_stuck');
  await files(bob).call('pretend', hash, 'pulling');
  await expect.poll(files(bob).fired, { timeout: 30_000 }).toEqual(['file_pulling_stuck']);
  const [report] = await files(bob).call<Array<{ heldMs: number; snapshot: Record<string, unknown> }>>('invariants');
  expect(report!.heldMs).toBeGreaterThanOrEqual(10_000);
  expect(report!.snapshot).toMatchObject({ file: { status: 'pulling', running: false } });
  expect(JSON.stringify(report)).not.toContain(hash!); // no hashes
});

test('waiting for a friend to come online while one who has it is online is reported (file_waiting_online)', async ({ crowd }) => {
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await needHooks(bob);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('zip') });
  await expect(bob.page.locator('.chat-log .att-card')).toHaveCount(1);
  const [hash] = Object.keys(await files(bob).call<Record<string, string>>('attachments'));
  bob.expectInvariant('file_waiting_online');
  await files(bob).call('pretend', hash, 'waiting');
  await expect(bob.page.locator('.chat-log .att-card')).toContainText('Waiting for Alice');
  await expect.poll(files(bob).fired, { timeout: 30_000 }).toEqual(['file_waiting_online']);
});

// Review of PR #69 (Grumpy Friend), 2026-10-16: a pull cancelled and asked again while the first still waited for its
// ICE servers ran twice; the first one's end set the picture back to the button over the second, and took the second's
// bookkeeping with it, so Cancel then stopped nothing.
test('regression: a picture cancelled and asked again while its first pull waited is one pull, and Cancel stops it', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.page.evaluate(slowUplink);
  // The Room's ICE servers for links never reach Bob: each pull of his waits its 5 s for them (client/links.ts).
  bob.wire.down = (frame) => (frame.includes('"t":"linkice"') ? null : frame);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: heavy(png(640, 480), 2 * 1024 * 1024) });
  const media = bob.page.locator('.chat-log .att-media');
  await media.getByRole('button', { name: 'Cancel' }).click({ timeout: 30_000 });
  await media.locator('button.att-get').click(); // both within the first pull's 5 s wait
  await expect(media.locator('figcaption')).toHaveText(/\b[1-9]\d?% of/, { timeout: 30_000 });
  // Bob changes his mind once more: it stops, and stays stopped while five more slices would have come.
  await media.getByRole('button', { name: 'Cancel' }).click();
  await expect(media.locator('button.att-get')).toBeVisible();
  await bob.page.waitForTimeout(5_000);
  await expect(media.locator('button.att-get')).toBeVisible();
  await expect(media.locator('img:not(.att-preview)')).toHaveCount(0);
});

// Attachments ticket 05 (Grumpy Friend, review of PR #68): Alice switches apps for half a minute after posting. The Room
// keeps her online (silence sweep 90 s), Bob's pull finds nobody answering, and when she answers again nothing tried it.
test('a picture that could not be pulled while its sender was briefly away comes by itself once she answers', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const held: string[] = [];
  alice.wire.down = (frame) => { if (!frame.includes('"t":"link"')) return frame; held.push(frame); return null; };
  const picture = png(640, 480);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: picture });
  await expect(bob.page.locator('.chat-log .att-media figcaption')).toContainText("Couldn't reach Alice. Trying again soon.", { timeout: 45_000 });

  // She is back: what was sent meanwhile reaches her at once, and she answers it. Nobody left the room or came back.
  alice.wire.down = null;
  for (const frame of held.splice(0)) alice.wire.deliver(frame);
  expect(await bob.online()).toContain('Alice');

  const shown = bob.page.locator('.chat-log .att-media img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 60_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

// Attachments ticket 05 (Grumpy Friend, review of PR #68): a holder serves eight links at once. Five friends pulling two
// photos each from a slow phone ask for ten: she now answers the two she has no place for "busy", and they ask again.
test('every friend gets the pictures of a busy holder by itself, once her places free', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const pullers = [];
  for (const name of ['Bob', 'Carol', 'Dave', 'Erin', 'Frank']) pullers.push(await crowd.open(name));
  await alice.page.evaluate(slowUplink);
  for (const [i, buffer] of [heavy(png(640, 480), 1024 * 1024), heavy(png(480, 640), 1024 * 1024)].entries()) {
    await alice.page.getByTestId('attach').setInputFiles({ name: `big-${i}.png`, mimeType: 'image/png', buffer });
  }
  for (const f of pullers) {
    await expect(f.page.locator('.chat-log .att-media img:not(.att-preview)'), `${f.name} has both`).toHaveCount(2, { timeout: 180_000 });
  }
});

// PR #69's preview, 2026-10-16 (Firefox): Bob's Try again came in the second his socket was being replaced after a
// drop (ticket 57). The pull's offer could not go out, nothing said so, and it sat at 0% for its whole connect timeout.
test('regression: a pull asked while the socket is being replaced is not left waiting for an offer that never went', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await alice.page.getByTestId('attach').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('zip, zip') });
  const card = bob.page.locator('.chat-log .att-card');
  await expect(card).toHaveCount(1);
  // His socket is gone and not back yet: he asks all the same.
  await bob.wire.cut();
  await card.getByRole('button', { name: /⬇/ }).click();
  bob.wire.restore();
  await bob.connected();
  // Well inside the 20 s a pull waits for an answer: the ask did not wait for one that could never come.
  await expect(card.locator('a.att-save')).toHaveAttribute('download', 'notes.zip', { timeout: 15_000 });
});

// Attachments ticket 02: a file comes from any friend who has it, not only from those who sent it. Bob pulled Alice's
// file; Alice is gone, and so is Bob for a while. Carol asks Dave, who never pulled it: he says so, and the file waits.
// When Bob is back Carol asks him, not Dave again, and gets it from him.
test('a file comes from a friend who pulled it once its sender is gone, past one who does not have it', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const carol = await crowd.open('Carol');
  const dave = await crowd.open('Dave');
  const notes = randomBytes(40_000);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: notes });
  const bobs = bob.page.locator('.chat-log .att-card');
  await bobs.getByRole('button', { name: /⬇/ }).click();
  await expect(bobs.locator('a.att-save')).toHaveAttribute('download', 'notes.zip', { timeout: 30_000 });
  await expect(dave.page.locator('.chat-log .att-card')).toHaveCount(1);
  const keyOf = (f: Friend) => (JSON.parse(f.wire.log.find((x) => x.dir === 'down' && x.frame.startsWith('{"t":"welcome"'))!.frame) as { you: { publicKey: string } }).you.publicKey;
  const [daveKey, bobKey] = [keyOf(dave), keyOf(bob)];
  /** The links Carol opened to a friend, by their offers. */
  const offersTo = (key: string) => carol.wire.log.filter((x) => x.dir === 'up' && x.frame.startsWith(`{"t":"link","to":"${key}"`) && x.frame.includes('"type":"offer"')).length;

  // Alice leaves; Bob closes his tab, his store kept in his browser.
  await alice.close();
  await bob.page.close();
  await expect.poll(async () => (await carol.online()).sort()).toEqual(['Carol', 'Dave']);
  const carols = carol.page.locator('.chat-log .att-card');
  await carols.getByRole('button', { name: /⬇/ }).click();
  await expect(carols).toContainText('Waiting for Alice', { timeout: 30_000 });
  expect(offersTo(daveKey), 'Dave was asked, and said it is not there').toBeGreaterThanOrEqual(1);

  // Bob is back: Carol asks him, not Dave again, and gets it.
  const asked = offersTo(daveKey);
  bob.page = await bob.context.newPage();
  bob.watch(bob.page);
  await bob.open();
  const save = carols.locator('a.att-save');
  await expect(save).toHaveAttribute('download', 'notes.zip', { timeout: 30_000 });
  const url = (await save.getAttribute('href'))!;
  expect(await carol.page.evaluate(pageHash(url), url)).toBe(sha256(notes));
  expect(offersTo(bobKey), 'Bob gave it').toBeGreaterThanOrEqual(1);
  expect(offersTo(daveKey), 'Dave, who said it is not there, was not asked again').toBe(asked);
});

// Attachments ticket 03: a large file comes in pieces, each checked and written to disk as it comes, and a pull that
// stopped goes on from the last piece it checked instead of from the start.
test('a large file stopped part way goes on from there, and arrives whole', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const picture = heavy(png(640, 480), 20 * 1024 * 1024); // over 16 MB: in pieces, and pulled on a click
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: picture });
  const media = bob.page.locator('.chat-log .att-media');
  await expect(media.locator('button.att-get')).toBeVisible({ timeout: 60_000 });
  // Once it is announced, Alice's uplink stalls after 272 slices of 64 KB (17 MB, past the first segment), until let go.
  await alice.page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    let slices = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as unknown as { releasePull: () => void }).releasePull = release;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      if (this.size === 64 * 1024 && ++slices > 272) await gate;
      return read.call(this);
    };
  });
  await media.locator('button.att-get').click();
  await expect(media.locator('figcaption')).toHaveText(/\b8\d% of 20 MB/, { timeout: 60_000 });
  // Bob stops it: the 17 MB he checked are kept (of a little over 20), and the button says so.
  const kept = Math.floor((100 * 17 * 1024 * 1024) / picture.length);
  await media.getByRole('button', { name: 'Cancel' }).click();
  await expect(media.locator('button.att-get')).toHaveText(new RegExp(`Resume, ${kept}% of 20 MB`));
  // Going on, with Alice's uplink still held: it starts there, not at 0, before a byte more can come.
  await media.locator('button.att-get').click();
  await expect(media.locator('figcaption')).toHaveText(new RegExp(`\\b${kept}% of 20 MB`), { timeout: 30_000 });
  await alice.page.evaluate(() => (window as unknown as { releasePull: () => void }).releasePull());
  const shown = media.locator('img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 120_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

// Report of 2026-10-16: a friend's download of a 24 MB photo on an iPhone was cut off by leaving the app, and started
// again from 0 bytes. Only whole segments of 16 MB were kept, so nothing of a file under 32 MB ever was before its end.
test('a large file cut off by a reload before 16 MB goes on from what it checked', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const picture = heavy(png(640, 480), 20 * 1024 * 1024);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: picture });
  const media = bob.page.locator('.chat-log .att-media');
  await expect(media.locator('button.att-get')).toBeVisible({ timeout: 60_000 });
  // Alice's uplink stalls after 160 slices of 64 KB (10 MB, inside the first segment), until let go.
  await alice.page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    let slices = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as unknown as { releasePull: () => void }).releasePull = release;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      if (this.size === 64 * 1024 && ++slices > 160) await gate;
      return read.call(this);
    };
  });
  await media.locator('button.att-get').click();
  const half = Math.floor((100 * 10 * 1024 * 1024) / picture.length);
  await expect(media.locator('figcaption')).toHaveText(new RegExp(`\\b${half}% of 20 MB`), { timeout: 60_000 });
  // What Bob checked reaches his disk while the pull still runs: a phone leaving the app gets no chance to save it.
  await expect.poll(() => bob.page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dave'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const store = db.transaction('kv', 'readonly').objectStore('kv');
      const all = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
        const keys = store.getAllKeys(), values = store.getAll();
        values.onsuccess = () => resolve({ keys: keys.result, values: values.result });
        values.onerror = () => reject(values.error);
      });
      return all.keys.flatMap((k, i) => (String(k).startsWith('partial:') ? [(all.values[i] as { verified: number }).verified] : []));
    } finally { db.close(); }
  }), { message: 'the 10 MB Bob checked are kept on disk', timeout: 15_000 }).toEqual([10 * 1024 * 1024]);
  await bob.page.reload();
  const again = bob.page.locator('.chat-log .att-media');
  await expect(again.locator('button.att-get')).toHaveText(new RegExp(`Resume, ${half}% of 20 MB`), { timeout: 30_000 });
  // Going on, with Alice's uplink still held: it starts there, not at 0, before a byte more can come.
  await again.locator('button.att-get').click();
  await expect(again.locator('figcaption')).toHaveText(new RegExp(`\\b${half}% of 20 MB`), { timeout: 30_000 });
  await alice.page.evaluate(() => (window as unknown as { releasePull: () => void }).releasePull());
  const shown = again.locator('img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 120_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

// Grumpy Friend, review of the report of 2026-10-16: each piece is flushed to disk and its progress saved before the next,
// and a cheap phone does that slower than Wi-Fi brings the bytes. Every byte was in and still being written when the
// wait for a sign of life, fed by arriving frames only, called the link lost (client/links.ts, `receive`).
test('a large file that comes faster than the disk takes it is not called a dropped connection', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const picture = heavy(png(640, 480), 20 * 1024 * 1024);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: picture });
  const media = bob.page.locator('.chat-log .att-media');
  await expect(media.locator('button.att-get')).toBeVisible({ timeout: 60_000 });
  // Bob's disk takes 1.5 s a piece: some 30 s of writing after Alice's last byte, past the 20 s wait.
  await bob.page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const go = () => post.call(this, message, { transfer: transfer ?? [] });
      if ((message as { t?: string })?.t === 'write') setTimeout(go, 1500); else go();
    } as Worker['postMessage'];
    const w = window as unknown as { failed: boolean };
    w.failed = false;
    new MutationObserver(() => { if (document.querySelector('.chat-log .att-media[data-status="failed"]')) w.failed = true; })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
  });
  await media.locator('button.att-get').click();
  const shown = media.locator('img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 120_000 });
  expect(await bob.page.evaluate(() => (window as unknown as { failed: boolean }).failed), 'the pull never failed').toBe(false);
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

// Grumpy Friend: a pull stopped on the app before 2026-10-17 kept its first 16 MB as a segment, `<hash>.0`, and its button
// says "Resume, 79%" after the update. It goes on from there, not from 0.
test('a large file part pulled by the app before 2026-10-17 goes on from its segments, as its button says', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  await needHooks(bob);
  const picture = heavy(png(640, 480), 20 * 1024 * 1024);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: picture });
  const media = bob.page.locator('.chat-log .att-media');
  await expect(media.locator('button.att-get')).toBeVisible({ timeout: 60_000 });
  // Alice's uplink stalls after 272 slices of 64 KB (17 MB), until let go.
  await alice.page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    let slices = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as unknown as { releasePull: () => void }).releasePull = release;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      if (this.size === 64 * 1024 && ++slices > 272) await gate;
      return read.call(this);
    };
  });
  await media.locator('button.att-get').click();
  await expect(media.locator('figcaption')).toHaveText(/\b8\d% of 20 MB/, { timeout: 60_000 });
  await media.getByRole('button', { name: 'Cancel' }).click();
  await expect(media.locator('button.att-get')).toHaveText(/Resume/);
  const [hash] = Object.keys(await files(bob).call<Record<string, string>>('attachments'));
  // What the app before left instead: the first 16 MB as segment `<hash>.0`, and its record.
  await bob.page.evaluate(async ([hash, size]) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('files');
    const whole = await (await dir.getFileHandle(hash)).getFile();
    const segment = await (await dir.getFileHandle(`${hash}.0`, { create: true })).createWritable();
    await segment.write(await whole.slice(0, 16 * 1024 * 1024).arrayBuffer());
    await segment.close();
    await dir.removeEntry(hash);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dave'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ verified: 16 * 1024 * 1024, size, at: Date.now() }, `partial:${hash}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, [hash!, picture.length] as const);
  await bob.page.reload();
  const kept = Math.floor((100 * 16 * 1024 * 1024) / picture.length);
  const again = bob.page.locator('.chat-log .att-media');
  await expect(again.locator('button.att-get')).toHaveText(new RegExp(`Resume, ${kept}% of 20 MB`), { timeout: 30_000 });
  // Going on, with Alice's uplink still held: it starts there, not at 0, before a byte more can come.
  await again.locator('button.att-get').click();
  await expect(again.locator('figcaption')).toHaveText(new RegExp(`\\b${kept}% of 20 MB`), { timeout: 30_000 });
  await alice.page.evaluate(() => (window as unknown as { releasePull: () => void }).releasePull());
  const shown = again.locator('img:not(.att-preview)');
  await expect(shown).toHaveCount(1, { timeout: 120_000 });
  const url = (await shown.getAttribute('src'))!;
  expect(await bob.page.evaluate(pageHash(url), url)).toBe(sha256(picture));
});

// Review of PR #72 (Grumpy Friend): a 4 GB video on a phone with 1 GB free. A full disk was taken for a dropped
// connection and tried again; it says so instead, and is not tried again by itself.
test('a browser out of room for a large file says so, and does not call it a dropped connection', async ({ crowd }) => {
  test.slow();
  const alice = await crowd.open('Alice');
  const bob = await crowd.open('Bob');
  const picture = heavy(png(640, 480), 20 * 1024 * 1024);
  await alice.page.getByTestId('attach').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: picture });
  const media = bob.page.locator('.chat-log .att-media');
  await expect(media.locator('button.att-get')).toBeVisible({ timeout: 60_000 });
  // Bob's disk is full after 3 pieces: his file writer (client/filewriter.ts) answers the fourth with the browser's error.
  await bob.page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    let pieces = 0;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const ask = message as { t?: string; id?: number };
      if (ask?.t === 'write' && ++pieces > 3) {
        setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: { id: ask.id, error: { name: 'QuotaExceededError', message: 'The quota has been exceeded.' } } })));
        return;
      }
      post.call(this, message, { transfer: transfer ?? [] });
    } as Worker['postMessage'];
  });
  await media.locator('button.att-get').click();
  await expect(media).toContainText("This browser can't keep files this large", { timeout: 60_000 });
  await expect(media).not.toContainText('Trying again soon');
});
