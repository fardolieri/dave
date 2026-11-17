import type { Page, Request } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { target } from './browsers';
import { expect, test, openMenu, pickTheme, themeNames } from './fixtures';

// PostHog is opt-in (ticket 32): a browser that has not said yes sends nothing there and keeps nothing of it.

const posthogStorage = (page: Page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage), ...document.cookie.split(';').map((c) => c.split('=')[0]!.trim())]
  .filter((k) => k.startsWith('ph_') || k.startsWith('__ph_')));

/**
 * Answers the notice once its bubble has popped in. It scales up from its corner after a delay, and Playwright found a
 * button stable while the bubble still waited at its first frame; the click then missed it, the
 * notice stayed open and the yes was never given (ticket 50: Firefox, 2026-10-12 and twice on 2026-10-15).
 */
async function answer(page: Page, button: 'Sure!' | 'Maybe later'): Promise<void> {
  const notice = page.getByRole('region', { name: 'Help find bugs' });
  await notice.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))).then(() => {}));
  await notice.getByRole('button', { name: button }).click();
}

test('a fresh browser is asked once, again only from the sidebar, and sends nothing to PostHog before a yes or after a no', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: null, plainUserAgent: true });
  const notice = alice.page.getByRole('region', { name: 'Help find bugs' });
  await expect(notice).toContainText('Want to help me find bugs?');
  await alice.say('hello'); // the room works with the question open
  await alice.join();
  expect(alice.posthog, 'no request to PostHog before an answer').toEqual([]);
  expect(await posthogStorage(alice.page)).toEqual([]);

  await answer(alice.page, 'Maybe later');
  await expect(notice).not.toBeVisible();
  await alice.page.reload();
  await alice.connected();
  await expect(notice).not.toBeVisible(); // asked once on its own
  await openMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Help find bugs', exact: true }).click(); // and again from the sidebar
  await expect(notice).toContainText('Nothing is sent unless you say yes');
  await openMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Help find bugs', exact: true }).click(); // a second click puts it away
  await expect(notice).not.toBeVisible();
  await alice.say('after the no');
  expect(alice.posthog, 'no request to PostHog after a no').toEqual([]);
  expect(alice.wire.frames('up', 'auth').every((a) => !('telemetry' in a)), 'the server was never told to report on her').toBe(true);
});

test('a yes starts PostHog and tells the server; stopping forgets it again', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: null, plainUserAgent: true });
  await answer(alice.page, 'Sure!');
  await expect.poll(() => alice.posthog.length, { message: 'PostHog started after the yes' }).toBeGreaterThan(0);
  await expect.poll(() => alice.posthog.some((u) => /\/e\/(\?|$)/.test(u)), { message: 'and sends events: opted in, not only loaded' }).toBe(true);
  // All of it through our own origin: tracker blockers drop requests to posthog.com, even from a friend who said yes.
  expect(alice.posthog.filter((u) => new URL(u).origin !== new URL(alice.page.url()).origin), 'nothing straight to PostHog').toEqual([]);
  // The build goes on every event as a super property, which the SDK keeps with its own state (its event bodies are compressed).
  const superProperties = () => alice.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ph_'))
    .map((k) => { try { return JSON.parse(localStorage.getItem(k)!) as Record<string, unknown>; } catch { return null; } })
    .find((v) => v && 'build_target' in v) ?? null);
  await expect.poll(superProperties, { message: 'the build is registered with the SDK' })
    .toMatchObject({ build_commit: expect.stringMatching(/^[0-9a-f]{40}$/), build_target: expect.stringMatching(/^(live|preview|e2e|local)$/) });
  await expect.poll(() => alice.wire.frames('up', 'telemetry')).toEqual([{ t: 'telemetry', on: true }]);
  await alice.page.reload();
  await alice.connected();
  await expect.poll(() => alice.wire.frames('up', 'auth').at(-1)?.['telemetry']).toBe(true);

  // The sidebar asks again, with what is sent in view, rather than switching it off unread
  await openMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Stop helping find bugs' }).click();
  const notice = alice.page.getByRole('region', { name: 'Help find bugs' });
  await expect(notice).toContainText('You are helping right now');
  await answer(alice.page, 'Maybe later');
  await expect(notice).not.toBeVisible();
  await openMenu(alice.page);
  await expect(alice.page.getByRole('button', { name: 'Help find bugs', exact: true })).toBeVisible();
  await expect.poll(() => alice.wire.frames('up', 'telemetry').at(-1)).toEqual({ t: 'telemetry', on: false });
  await expect.poll(() => posthogStorage(alice.page)).toEqual([]);
  // A yes again on the same page: the SDK is still loaded, and its reset on the no dropped the build, which comes back
  await openMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Help find bugs', exact: true }).click();
  await answer(alice.page, 'Sure!');
  await expect.poll(superProperties, { message: 'the build is registered again after a no and a yes' })
    .toMatchObject({ build_commit: expect.stringMatching(/^[0-9a-f]{40}$/), build_target: expect.stringMatching(/^(live|preview|e2e|local)$/) });
  await openMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Stop helping find bugs' }).click();
  await answer(alice.page, 'Maybe later');
  await expect.poll(() => posthogStorage(alice.page)).toEqual([]);
  await alice.page.reload();
  await alice.connected();
  const before = alice.posthog.length;
  await alice.say('after stopping');
  await alice.page.waitForTimeout(1000);
  expect(alice.posthog.length, 'nothing more after stopping').toBe(before);
});

test('with the yes, every event says which theme is on screen, from the load and after each pick', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { plainUserAgent: true });
  // A super property, kept by the SDK with its state like the build (the event bodies are compressed).
  const theme = () => alice.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ph_'))
    .map((k) => { try { return JSON.parse(localStorage.getItem(k)!) as Record<string, unknown>; } catch { return null; } })
    .find((v) => v && 'build_target' in v)?.['theme'] ?? null);
  await expect.poll(theme, { message: 'the default look, before any pick' }).toBe('default');
  const looks = (await themeNames(alice.page)).filter(Boolean);
  const picked = looks[0]!;
  await pickTheme(alice.page, picked);
  await expect.poll(theme, { message: 'the picked theme from the pick on' }).toBe(picked);
  // Another theme in this browser's store before a reload (the SDK's own state still says the first): the page registers
  // the stored one as it loads.
  const other = looks[1]!;
  await alice.page.evaluate(async (t) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // the theme's fonts requested, then in:
    await document.fonts.ready; // a reload must not cut off a font download (themes.spec.ts)
    // The room's own look, which the pick above stored: every room's, as the one on screen is the only one here
    const rooms = JSON.parse(localStorage.getItem('dave.roomThemes') ?? '{}') as Record<string, string>;
    localStorage.setItem('dave.roomThemes', JSON.stringify(Object.fromEntries(Object.keys(rooms).map((k) => [k, t]))));
  }, other);
  await alice.page.reload();
  await alice.connected();
  await expect.poll(theme, { message: 'after a reload, the stored pick' }).toBe(other);
});

type Sent = { event: string; timestamp?: string; properties?: Record<string, unknown> };
/** The events a request to PostHog's capture endpoint (`/e/`, `/i/v0/e/`) carries; none for any other request. */
function eventsOf(r: Request): Sent[] {
  const url = new URL(r.url());
  const body = r.postDataBuffer();
  if (!/\/e\/$/.test(url.pathname) || !body) return [];
  // Gzipped or not, as the SDK pleases: told apart by gzip's magic bytes.
  // A beacon is a form: `data=` and the batch in base64.
  const text = (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString();
  const json = JSON.parse(text.startsWith('data=') ? Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString() : text) as unknown;
  return (Array.isArray(json) ? json : (json as { batch?: unknown[] }).batch ?? [json]) as Sent[];
}

test('the app\'s own events wait to go to PostHog together, with the time each happened, and go when the page is left', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { plainUserAgent: true });
  const requests: Sent[][] = [];
  // On the context's route, as the fixtures' stand-in for PostHog: a request event may miss one the service worker sends.
  await alice.page.context().route(/\/diag\//, (route) => { const events = eventsOf(route.request()); if (events.length) requests.push(events); return route.fallback(); });
  const said = Date.now();
  await alice.say('one');
  await alice.say('two');
  // Past the 3 s in which the SDK would have sent them by itself: held, as they are for up to 30 s (core/outbox.ts).
  await alice.page.waitForTimeout(5000);
  const named = (name: string) => requests.filter((r) => r.some((e) => e.event === name));
  expect(named('message_sent'), 'held').toEqual([]);
  // The page going away. A real one (a reload) sends by beacon, which Playwright does not see from a page that is leaving.
  const left = Date.now();
  await alice.page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); });
  await expect.poll(() => named('message_sent').length, { message: 'sent as the page went' }).toBeGreaterThan(0);
  const [request, ...more] = named('message_sent');
  expect(more, 'in one request').toEqual([]);
  const texts = request!.filter((e) => e.event === 'message_sent');
  expect(texts, 'both texts').toHaveLength(2);
  for (const e of texts) {
    const at = Date.parse(e.timestamp ?? '');
    expect(at, 'the time it happened, not the time it went').toBeGreaterThanOrEqual(said - 1000);
    expect(at, 'the time it happened, not the time it went').toBeLessThan(left - 4000);
    expect(e.properties, 'the time carried to the SDK is taken off again').not.toHaveProperty('held_at');
  }
});

test('a yes during the handshake neither refuses the room nor gets lost', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: null, plainUserAgent: true, connect: false });
  // Hold the challenge back: the socket is open but not yet let in, which is when the answer is given here.
  let challenge: string | null = null;
  alice.wire.down = (frame) => (challenge === null && frame.includes('"t":"challenge"') ? ((challenge = frame), null) : frame);
  await alice.page.goto('/');
  await expect.poll(() => challenge).not.toBeNull();
  await answer(alice.page, 'Sure!');
  await alice.page.waitForTimeout(300);
  alice.wire.deliver(challenge!);
  await alice.connected(); // not refused: nothing went up before the welcome
  expect(alice.wire.frames('up', 'auth').at(-1)?.['telemetry'], 'the auth carried the yes').toBe(true);
});

test('a problem report still goes without the opt-in, alone and saying where it goes', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: 'off', plainUserAgent: true });
  await openMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Report a problem' }).click();
  const dialog = alice.page.locator('dialog.report');
  await expect(dialog.locator('.hint')).toContainText('sent to PostHog');
  await expect(dialog.locator('.hint')).toContainText('Only this report goes');
  await dialog.locator('textarea').fill('automated test report, please ignore');
  const sent = alice.page.waitForRequest(/\/i\/v0\/e\/$/);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.locator('.ok')).toContainText('Sent, thank you');
  await expect.poll(() => alice.posthog).toEqual([expect.stringMatching(/\/i\/v0\/e\/$/)]);
  expect(new URL(alice.posthog[0]!).origin, 'through our own origin, past tracker blockers').toBe(new URL(alice.page.url()).origin);
  // It says which copy of the app sent it, so a report from a preview or a test build is not taken for one from prod.
  expect((await sent).postDataJSON()).toMatchObject({
    event: 'bug_report',
    properties: { build_commit: expect.stringMatching(/^[0-9a-f]{40}$/), build_target: expect.stringMatching(/^(live|preview|e2e|local)$/) },
  });
  expect(await posthogStorage(alice.page)).toEqual([]);
});

test('the Worker really passes /diag on to PostHog: scripts and remote config to its assets host, the rest to its ingest host', async ({ crowd }) => {
  test.skip(!target, 'the local e2e build has no PostHog host: run against a preview');
  const alice = await crowd.open('Alice', { telemetry: 'off' });
  // The context's own request client is not routed, so this reaches the deployed Worker, which the friends' pages never do here.
  const api = alice.context.request;
  const headers = { 'sec-fetch-mode': 'cors' }; // as the SDK's requests have: not a page load, which gets the app
  const key = 'phc_qN9fsscYFP3YPfBdoNu4gyK2VsqGaXzALoASMUfJqm7q'; // the public project token (.env)
  const config = await api.get(`/diag/array/${key}/config.js`, { headers });
  expect(config.status(), 'remote config').toBe(200);
  expect(await config.text(), 'from PostHog, not the app').not.toMatch(/<!doctype html/i);
  expect((await api.get('/diag/static/recorder.js', { headers })).status(), 'the session recorder').toBe(200);
  expect((await api.post('/diag/flags/?v=2', { headers, data: { token: key, distinct_id: 'e2e-proxy-check' } })).status(), 'a POST, body and all').toBe(200);
});
