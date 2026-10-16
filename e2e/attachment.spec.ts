import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, needHooks, test, type Friend } from './fixtures';

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
