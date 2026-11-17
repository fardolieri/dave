import type { Route } from '@playwright/test';
import { expect, newSecret, test, type Friend } from './fixtures';

// Watch parties (client/party.ts): a YouTube card of the chat, watched together by friends in the call, in step. With
// YouTube's real player: Rick Astley's video is the one YouTube plays to a headless browser on a datacenter's address
// (this dev box and GitHub's runners, Chromium, probed 2026-11-14); others it asks to sign in. Firefox gets error 150 for
// it there, so these run in Chromium only.

const RICK = 'dQw4w9WgXcQ';
const TITLE = 'Rick Astley - Never Gonna Give You Up';
const CORS = { 'access-control-allow-origin': '*' };
const serve = (type: string, body: Buffer | string) => (r: Route) => r.fulfill({ status: 200, contentType: type, headers: CORS, body });

/** The card's thumbnail and title, made up: only the player is YouTube's. */
async function cardFor(f: Friend) {
  const jpeg = await f.page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const g = c.getContext('2d')!;
    g.fillStyle = '#c33';
    g.fillRect(0, 0, 1280, 720);
    const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/jpeg'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await f.context.route('https://i.ytimg.com/**', serve('image/jpeg', Buffer.from(jpeg)));
  await f.context.route('https://www.youtube.com/oembed?**', serve('application/json', JSON.stringify({ title: TITLE, author_name: 'Rick Astley' })));
}

/** Friends whose browser YouTube refused (403 to its player's own requests), by name. */
const refused = new Set<string>();

/**
 * A friend's browser, what YouTube's player logs allowed: headless Chromium has no graphics adapter to give it, the
 * player asks for the CPU's pressure readings, which its frame is not given (allow=, PartyPlayer), and YouTube refuses
 * some of GitHub's runners outright (403 to its player's requests, 2026-11-15), which `youtubePlays` turns into a skip.
 */
async function open(crowd: { open: (name: string, options?: { rooms?: Array<{ secret: string; name: string }> }) => Promise<Friend> }, name: string, options?: { rooms?: Array<{ secret: string; name: string }> }): Promise<Friend> {
  const f = await crowd.open(name, options);
  // As the refusal showed on a runner: the console of YouTube's frame says its own requests were answered 403.
  const refusal = /^Failed to load resource: the server responded with a status of 403 \([^)]*\)$/;
  f.page.on('console', (m) => { if (refusal.test(m.text()) && /^https:\/\/www\.youtube-nocookie\.com\/youtubei\//.test(m.location().url)) refused.add(name); });
  f.expectWarning(/^error: Failed to load resource: the server responded with a status of 403 \([^)]*\) \(https:\/\/www\.youtube-nocookie\.com\/youtubei\//);
  f.expectWarning(/^warning: No available adapters\.$/);
  f.expectWarning(/^error: Permissions policy violation: compute-pressure is not allowed in this document\.$/);
  return f;
}

const tile = (f: Friend) => f.page.locator('.shares .party');

/**
 * Waits for YouTube to play the video to this friend. A runner YouTube refuses (some of GitHub's, from one run to the
 * next) skips the test: what it tests is the app with YouTube's player, which YouTube did not give it.
 */
async function youtubePlays(f: Friend) {
  const played = async () => (await where(f).catch(() => ({ t: 0 }))).t > 0.5;
  await expect.poll(async () => (await played()) || refused.has(f.name), { timeout: 45_000 }).toBe(true).catch(() => {});
  const plays = await played();
  test.skip(!plays && refused.has(f.name), 'YouTube refused this runner: 403 to its player\'s requests');
  expect(plays, `YouTube's player plays to ${f.name}`).toBe(true);
}
const player = (f: Friend) => tile(f).locator('iframe').contentFrame();
/**
 * Waits for a friend's player to show the frame at `t` seconds, paused and unmuted: not YouTube's thumbnail of a video
 * it has not started (cued), which shows no frame. A runner YouTube refuses skips the test, as in `youtubePlays`.
 */
async function heldAt(f: Friend, t: number) {
  const held = async () =>
    (await player(f).locator('video').evaluate((v: HTMLVideoElement, t) => v.paused && !v.muted && v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.5, t).catch(() => false))
    && !(await player(f).locator('.ytmCuedOverlayPlayButton').isVisible());
  await expect.poll(async () => (await held()) || refused.has(f.name), { timeout: 30_000 }).toBe(true).catch(() => {});
  const shown = await held();
  test.skip(!shown && refused.has(f.name), 'YouTube refused this runner: 403 to its player\'s requests');
  expect(shown, `${f.name}'s player shows the frame at ${t} s, paused`).toBe(true);
}
/** Where a friend's video is, and whether it plays, as YouTube's own video element says. */
const where = (f: Friend) => player(f).locator('video').evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, playing: !v.paused }));
/** Every friend's at once, so one read does not wait for another. */
const all = (...fs: Friend[]) => Promise.all(fs.map(where));
/** Whether they all play, or all are paused, within `within` seconds of each other. */
const inStep = async (fs: Friend[], playing: boolean, within: number) => {
  const w = await all(...fs);
  const ts = w.map((x) => x.t);
  return w.every((x) => x.playing === playing) && Math.max(...ts) - Math.min(...ts) <= within;
};
/** How fast each friend's video plays, as YouTube's own video element says. */
const rates = (...fs: Friend[]) => Promise.all(fs.map((f) => player(f).locator('video').evaluate((v: HTMLVideoElement) => v.playbackRate)));

/** Shows YouTube's controls, as the pointer over the player does. */
async function hover(f: Friend) {
  const box = (await tile(f).locator('iframe').boundingBox())!;
  await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await f.page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 3);
}

/**
 * A seek on YouTube's bar, as the friend clicks it, to `fraction` of the video. A click on its controls hidden only shows
 * them, as on a touch screen; the friend clicks again, as anyone would, until the video has gone there.
 */
async function seek(f: Friend, fraction: number) {
  const bar = player(f).getByRole('slider', { name: 'Seek slider' });
  for (let tries = 0; tries < 4; tries++) {
    await hover(f);
    const box = (await bar.boundingBox())!;
    await f.page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    const duration = await player(f).locator('video').evaluate((v: HTMLVideoElement) => v.duration);
    const went = await expect.poll(async () => Math.abs((await where(f)).t - duration * fraction) < 5, { timeout: 3000 }).toBe(true).then(() => true, () => false);
    if (went) return;
  }
  throw new Error(`${f.name}'s seek on YouTube's bar did not take`);
}

/** A speed picked in YouTube's settings, as the friend picks it ('1.5x'). */
async function speed(f: Friend, label: string) {
  await hover(f);
  await player(f).getByRole('button', { name: 'Playback Settings' }).click();
  await player(f).getByRole('menuitem', { name: /^Speed/ }).click();
  await player(f).getByRole('button', { name: label, exact: true }).click();
}

/**
 * YouTube's play/pause button, as the friend presses it: the big one over a video that has not played yet, else the one
 * in its controls, which show once the pointer is over the player (a press on them hidden only shows them).
 */
async function playPause(f: Friend) {
  const cued = player(f).getByRole('button', { name: 'Play video', exact: true }).and(player(f).locator('.ytmCuedOverlayPlayButton'));
  if (await cued.isVisible()) { await cued.click(); return; }
  await hover(f);
  await player(f).locator('.player-control-play-pause-icon').click();
}

test.beforeEach(({ browserName }) => {
  refused.clear();
  test.skip(browserName === 'firefox', 'YouTube refuses Firefox on a datacenter address (error 150), and plays Chromium the one video');
});

test('a watch party: started from a card, joined from its tile, played, paused, sought and sped up by anyone in it, in step', async ({ crowd }) => {
  test.setTimeout(240_000);
  const alice = await open(crowd, 'Alice');
  const bob = await open(crowd, 'Bob');
  const carol = await open(crowd, 'Carol');
  await cardFor(alice);
  await alice.join();
  await bob.join();
  await alice.composer.fill(`https://youtu.be/${RICK}`);
  await expect(alice.staged.locator('.size')).toHaveText('Rick Astley');
  await alice.composer.press('Enter');

  // Only a friend in the call may start one; Carol is not in it.
  await expect(bob.page.locator('.chat-log .att-video').getByRole('button', { name: 'Watch together' })).toBeVisible({ timeout: 30_000 });
  await expect(carol.page.locator('.chat-log .att-video')).toBeVisible({ timeout: 30_000 });
  await expect(carol.page.locator('.chat-log .att-video').getByRole('button', { name: 'Watch together' })).toHaveCount(0);
  await alice.page.locator('.chat-log .att-video').getByRole('button', { name: 'Watch together' }).click();

  // It shows up for everyone, as a share does: a tile with the card, its title and who is in it. It goes on paused at
  // its start, its first frame showing, for Alice to play when everyone is there.
  await expect(player(alice).locator('video')).toBeAttached({ timeout: 30_000 });
  await heldAt(alice, 0);
  await expect(tile(bob)).toContainText(TITLE);
  await expect(tile(bob)).toContainText('Click to watch together');
  await expect(tile(bob).locator('.share-faces .face')).toHaveCount(1);
  await expect(tile(carol)).toContainText('Join to watch');
  await tile(carol).click(); // not in the call: nothing
  await expect(tile(carol).locator('iframe')).toHaveCount(0);

  // Alice plays it, and Bob comes in where it is.
  await playPause(alice);
  await youtubePlays(alice);
  await tile(bob).click();
  await expect(tile(bob).locator('.share-faces .face')).toHaveCount(2);
  await youtubePlays(bob);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 30_000 }).toBe(true);

  // Bob pauses in YouTube's player: Alice's pauses too, at the same frame.
  await playPause(bob);
  await expect.poll(() => inStep([alice, bob], false, 0.35), { timeout: 15_000 }).toBe(true);
  // Alice plays it again.
  await playPause(alice);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Alice seeks on YouTube's bar, to about 40 %: Bob's goes there too.
  await seek(alice, 0.4);
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t > 60), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Bob seeks back, and Alice seeks on right after her app has put her player where Bob's went: the last seek is the
  // party's. (A seek while the app's own is under way, as a slow runner's often are: test/party.test.ts, `fromSeeking`.)
  await seek(bob, 0.1);
  const duration = await player(alice).locator('video').evaluate((v: HTMLVideoElement) => v.duration);
  await expect.poll(async () => (await where(alice)).t < duration * 0.2, { timeout: 15_000 }).toBe(true);
  await seek(alice, 0.7);
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t > 140), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Bob makes it faster in YouTube's settings: Alice's goes as fast.
  await speed(bob, '1.5x');
  await expect.poll(() => rates(alice, bob), { timeout: 15_000 }).toEqual([1.5, 1.5]);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Carol joins the call, and the party, where it is and as fast: by Watch together on the card the party plays, which
  // puts her in it where it is, not from its start (review of #146). In it, the card queues instead.
  await carol.join();
  await carol.page.locator('.chat-log .att-video').getByRole('button', { name: 'Watch together' }).click();
  await youtubePlays(carol);
  await expect.poll(() => inStep([alice, bob, carol], true, 1.5), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => rates(carol), { timeout: 15_000 }).toEqual([1.5]);
  await expect(tile(alice).locator('.share-faces .face')).toHaveCount(3);
  expect((await all(alice, bob, carol)).every((w) => w.t > 140)).toBe(true);
  await expect(carol.page.locator('.chat-log .att-video').getByRole('button', { name: 'Watch together' })).toHaveCount(0);

  // Alice leaves it: it goes on for the others, and she can come back to it from its tile.
  await tile(alice).getByRole('button', { name: 'Stop watching' }).click();
  await expect(tile(alice).locator('iframe')).toHaveCount(0);
  await expect(tile(alice)).toContainText('Click to watch together');
  await expect(tile(bob).locator('.share-faces .face')).toHaveCount(2);
  await expect.poll(() => inStep([bob, carol], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Bob, who made no change, leaves the call; Carol, the last in it, goes on, and pauses it for herself.
  await bob.leave();
  await expect(tile(carol).locator('.share-faces .face')).toHaveCount(1);
  await playPause(carol);
  await expect.poll(async () => (await where(carol)).playing, { timeout: 15_000 }).toBe(false);
  // She leaves it too: nobody is in one, and its tile goes.
  await tile(carol).getByRole('button', { name: 'Stop watching' }).click();
  for (const f of [alice, carol]) await expect(tile(f)).toHaveCount(0);
});

test('a friend who joins a paused party finds it paused, where it is, and it plays on from there for everyone, a newcomer to the room too', async ({ crowd }) => {
  test.setTimeout(180_000);
  const alice = await open(crowd, 'Alice');
  const bob = await open(crowd, 'Bob');
  await cardFor(alice);
  await alice.join();
  await bob.join();
  await alice.composer.fill(`https://youtu.be/${RICK}`);
  await expect(alice.staged.locator('.size')).toHaveText('Rick Astley');
  await alice.composer.press('Enter');
  await alice.page.locator('.chat-log .att-video').getByRole('button', { name: 'Watch together' }).click();
  await heldAt(alice, 0);
  await playPause(alice);
  await youtubePlays(alice);
  await expect.poll(async () => (await where(alice)).t > 3, { timeout: 30_000 }).toBe(true);
  await playPause(alice);
  await expect.poll(async () => (await where(alice)).playing, { timeout: 15_000 }).toBe(false);
  const pausedAt = (await where(alice)).t;

  // A player that never played starts on a seek (YouTube's way): Bob's must not set the party playing.
  await tile(bob).click();
  await expect(tile(bob).locator('iframe')).toBeAttached();
  await bob.page.waitForTimeout(5000);
  expect((await where(alice)).playing).toBe(false);
  expect((await where(bob)).playing).toBe(false);
  // Bob's player shows the frame Alice paused at, not YouTube's thumbnail of a video it has not started: played muted to
  // get there, and unmuted again.
  await heldAt(bob, pausedAt);
  expect((await where(bob)).playing).toBe(false);
  expect((await where(alice)).playing).toBe(false);

  // Bob plays it: both go on from where Alice paused it.
  await playPause(bob);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 30_000 }).toBe(true);
  const [a] = await all(alice);
  expect(a!.t).toBeGreaterThan(pausedAt);
  expect(a!.t).toBeLessThan(pausedAt + 15);

  // Carol comes to the room only now: what was said before, the card too, she does not see (ADR 0009). The party she
  // joins all the same, from its tile, which has its title and no picture: her browser does not ask YouTube for one.
  const carol = await open(crowd, 'Carol', { rooms: [{ secret: newSecret(), name: 'Other' }] });
  await carol.page.goto(`/#${crowd.room.secret}/${encodeURIComponent(crowd.room.name)}`);
  await carol.connected();
  await expect(carol.selectedRoom.locator('.room-title')).toHaveText(crowd.room.name);
  await carol.join();
  await expect(carol.page.locator('.chat-log .att-video')).toHaveCount(0);
  await expect(tile(carol)).toContainText(TITLE, { timeout: 30_000 });
  await expect(tile(carol)).toContainText('Click to watch together');
  await tile(carol).click();
  await youtubePlays(carol);
  await expect.poll(() => inStep([alice, bob, carol], true, 1.5), { timeout: 30_000 }).toBe(true);
});

test('a watch party\'s queue: cards queued by anyone in it, moved and taken out, the next played at the end, skipped to, and a card played now', async ({ crowd }) => {
  test.setTimeout(240_000);
  const ZOO = 'jNQXAC9IVRw';
  const ZOO_TITLE = 'Me at the zoo';
  const alice = await open(crowd, 'Alice');
  const bob = await open(crowd, 'Bob');
  await cardFor(alice);
  // Another video's card, its own picture and title (later routes come first). It is never played: YouTube plays the
  // test browsers Rick Astley's video alone.
  const blue = await alice.page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const g = c.getContext('2d')!;
    g.fillStyle = '#33c';
    g.fillRect(0, 0, 1280, 720);
    const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/jpeg'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await alice.context.route(`https://i.ytimg.com/vi/${ZOO}/**`, serve('image/jpeg', Buffer.from(blue)));
  await alice.context.route((u) => u.href.startsWith('https://www.youtube.com/oembed?') && u.href.includes(ZOO), serve('application/json', JSON.stringify({ title: ZOO_TITLE, author_name: 'jawed' })));
  await alice.join();
  await bob.join();
  await alice.composer.fill(`https://youtu.be/${RICK}`);
  await expect(alice.staged.locator('.size')).toHaveText('Rick Astley');
  await alice.composer.press('Enter');
  await alice.composer.fill(`https://youtu.be/${ZOO}`);
  await expect(alice.staged.locator('.size')).toHaveText('jawed');
  await alice.composer.press('Enter');
  const card = (f: Friend, title: string) => f.page.locator('.chat-log .att-video').filter({ hasText: title });
  const queue = (f: Friend) => tile(f).locator('.party-queue li .queued-title');

  await card(alice, TITLE).getByRole('button', { name: 'Watch together' }).click();
  await heldAt(alice, 0);
  await playPause(alice);
  await youtubePlays(alice);
  // Out of the party, Bob may watch together, or a card big; queueing is for those in it, who watch no card big meanwhile.
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Watch together' })).toBeVisible({ timeout: 30_000 });
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Big picture', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Add to queue' })).toHaveCount(0);
  await tile(bob).click();
  await youtubePlays(bob);
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Watch together' })).toHaveCount(0);
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Big picture', exact: true })).toHaveCount(0);
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Play now' })).toBeVisible();

  // Bob queues the other video, Alice this one, twice: the button says each took.
  await card(bob, ZOO_TITLE).getByRole('button', { name: 'Add to queue' }).click();
  await expect(card(bob, ZOO_TITLE).getByRole('button', { name: 'Added ✓' })).toBeVisible();
  await expect(queue(alice)).toHaveText([ZOO_TITLE]);
  await card(alice, TITLE).getByRole('button', { name: 'Add to queue' }).click();
  await expect(queue(bob)).toHaveText([ZOO_TITLE, TITLE]);
  await card(alice, TITLE).getByRole('button', { name: 'Add to queue' }).click();
  await expect(queue(bob)).toHaveText([ZOO_TITLE, TITLE, TITLE]);
  await expect(queue(alice)).toHaveText([ZOO_TITLE, TITLE, TITLE]);
  // Each with the face of who queued it.
  await expect(tile(alice).locator('.party-queue li .face')).toHaveCount(3);

  // Bob moves the other video down, up again, then down to the end.
  await tile(bob).getByRole('button', { name: `Move ${ZOO_TITLE} down` }).click();
  await expect(queue(alice)).toHaveText([TITLE, ZOO_TITLE, TITLE]);
  await tile(bob).getByRole('button', { name: `Move ${ZOO_TITLE} up` }).click();
  await expect(queue(alice)).toHaveText([ZOO_TITLE, TITLE, TITLE]);
  await tile(bob).getByRole('button', { name: `Move ${ZOO_TITLE} down` }).click();
  await expect(queue(bob)).toHaveText([TITLE, ZOO_TITLE, TITLE]);
  await tile(bob).getByRole('button', { name: `Move ${ZOO_TITLE} down` }).click();
  await expect(queue(alice)).toHaveText([TITLE, TITLE, ZOO_TITLE]);

  // Alice seeks to a few seconds before the end: when it ends, the next plays from its start, for both, out of the queue.
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);
  await seek(alice, 0.97);
  await expect(queue(bob)).toHaveText([TITLE, ZOO_TITLE], { timeout: 30_000 });
  await expect(queue(alice)).toHaveText([TITLE, ZOO_TITLE]);
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t < 30), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Further on, Bob skips: the next goes on now, from its start, playing as the party was.
  await seek(alice, 0.4);
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t > 60), { timeout: 15_000 }).toBe(true);
  await tile(bob).getByRole('button', { name: 'Skip' }).click();
  await expect(queue(alice)).toHaveText([ZOO_TITLE]);
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t < 30), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);

  // Further on, Bob plays this card now: it goes on from its start, playing, and the queue stays as it was. Further on
  // elsewhere than before the skip: a jump back to where a player was before the app's own seek, a moment after it, is
  // taken for a report from before that seek (ADR 0012), and put right (a runner of #159's preview).
  await seek(alice, 0.6);
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t > 100), { timeout: 15_000 }).toBe(true);
  await card(bob, TITLE).getByRole('button', { name: 'Play now' }).click();
  await expect.poll(async () => (await all(alice, bob)).every((w) => w.t < 30), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => inStep([alice, bob], true, 1.5), { timeout: 15_000 }).toBe(true);
  await expect(queue(alice)).toHaveText([ZOO_TITLE]);
  await expect(queue(bob)).toHaveText([ZOO_TITLE]);

  // Alice takes the last one out: nothing to skip to.
  await tile(alice).getByRole('button', { name: `Remove ${ZOO_TITLE}` }).click();
  for (const f of [alice, bob]) {
    await expect(tile(f).locator('.party-queue')).toHaveCount(0);
    await expect(tile(f).getByRole('button', { name: 'Skip' })).toHaveCount(0);
  }
});
