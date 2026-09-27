import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// PostHog is opt-in (ticket 32): a browser that has not said yes sends nothing there and keeps nothing of it.

const posthogStorage = (page: Page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage), ...document.cookie.split(';').map((c) => c.split('=')[0]!.trim())]
  .filter((k) => k.startsWith('ph_') || k.startsWith('__ph_')));

test('a fresh browser is asked once, again only from the sidebar, and sends nothing to PostHog before a yes or after a no', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: null, plainUserAgent: true });
  const notice = alice.page.getByRole('region', { name: 'Help find bugs' });
  await expect(notice).toContainText('Want to help me find bugs?');
  await alice.say('hello'); // the room works with the question open
  await alice.join();
  expect(alice.posthog, 'no request to PostHog before an answer').toEqual([]);
  expect(await posthogStorage(alice.page)).toEqual([]);

  await notice.getByRole('button', { name: 'Maybe later' }).click();
  await expect(notice).not.toBeVisible();
  await alice.page.reload();
  await alice.connected();
  await expect(notice).not.toBeVisible(); // asked once on its own
  await alice.page.getByRole('button', { name: 'Help find bugs', exact: true }).click(); // and again from the sidebar
  await expect(notice).toContainText('Nothing is sent unless you say yes');
  await alice.page.getByRole('button', { name: 'Help find bugs', exact: true }).click(); // a second click puts it away
  await expect(notice).not.toBeVisible();
  await alice.say('after the no');
  expect(alice.posthog, 'no request to PostHog after a no').toEqual([]);
  expect(alice.wire.frames('up', 'auth').every((a) => !('telemetry' in a)), 'the server was never told to report on her').toBe(true);
});

test('a yes starts PostHog and tells the server; stopping forgets it again', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: null, plainUserAgent: true });
  await alice.page.getByRole('region', { name: 'Help find bugs' }).getByRole('button', { name: 'Sure!' }).click();
  await expect.poll(() => alice.posthog.length, { message: 'PostHog started after the yes' }).toBeGreaterThan(0);
  await expect.poll(() => alice.posthog.some((u) => /\/e\/(\?|$)/.test(u)), { message: 'and sends events: opted in, not only loaded' }).toBe(true);
  await expect.poll(() => alice.wire.frames('up', 'telemetry')).toEqual([{ t: 'telemetry', on: true }]);
  await alice.page.reload();
  await alice.connected();
  await expect.poll(() => alice.wire.frames('up', 'auth').at(-1)?.['telemetry']).toBe(true);

  // The sidebar asks again, with what is sent in view, rather than switching it off unread
  await alice.page.getByRole('button', { name: 'Stop helping find bugs' }).click();
  const notice = alice.page.getByRole('region', { name: 'Help find bugs' });
  await expect(notice).toContainText('You are helping right now');
  await notice.getByRole('button', { name: 'Maybe later' }).click();
  await expect(notice).not.toBeVisible();
  await expect(alice.page.getByRole('button', { name: 'Help find bugs', exact: true })).toBeVisible();
  await expect.poll(() => alice.wire.frames('up', 'telemetry').at(-1)).toEqual({ t: 'telemetry', on: false });
  await expect.poll(() => posthogStorage(alice.page)).toEqual([]);
  await alice.page.reload();
  await alice.connected();
  const before = alice.posthog.length;
  await alice.say('after stopping');
  await alice.page.waitForTimeout(1000);
  expect(alice.posthog.length, 'nothing more after stopping').toBe(before);
});

test('a yes during the handshake neither refuses the room nor gets lost', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: null, plainUserAgent: true, connect: false });
  // Hold the challenge back: the socket is open but not yet let in, which is when the answer is given here.
  let challenge: string | null = null;
  alice.wire.down = (frame) => (challenge === null && frame.includes('"t":"challenge"') ? ((challenge = frame), null) : frame);
  await alice.page.goto('/');
  await expect.poll(() => challenge).not.toBeNull();
  await alice.page.getByRole('region', { name: 'Help find bugs' }).getByRole('button', { name: 'Sure!' }).click();
  await alice.page.waitForTimeout(300);
  alice.wire.deliver(challenge!);
  await alice.connected(); // not refused: nothing went up before the welcome
  expect(alice.wire.frames('up', 'auth').at(-1)?.['telemetry'], 'the auth carried the yes').toBe(true);
});

test('a problem report still goes without the opt-in, alone and saying where it goes', async ({ crowd }) => {
  const alice = await crowd.open('Alice', { telemetry: 'off', plainUserAgent: true });
  await alice.page.getByRole('button', { name: 'Report a problem' }).click();
  const dialog = alice.page.locator('dialog.report');
  await expect(dialog.locator('.hint')).toContainText('sent to PostHog');
  await expect(dialog.locator('.hint')).toContainText('Only this report goes');
  await dialog.locator('textarea').fill('automated test report, please ignore');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.locator('.ok')).toContainText('Sent, thank you');
  await expect.poll(() => alice.posthog).toEqual([expect.stringMatching(/\/i\/v0\/e\/$/)]);
  expect(await posthogStorage(alice.page)).toEqual([]);
});
