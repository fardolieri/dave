import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from './fixtures';

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
