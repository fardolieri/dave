/**
 * Shared harness for the end-to-end suite. A test gets `crowd`, which opens friends: each friend is its own browser context
 * (own storage, so own identity key), seeded with rooms and a name the way the app stores them, and routed through a
 * WebSocket proxy we control. The proxy is the "server as an adversary" lever: it can cut the socket, refuse reconnects, or
 * rewrite and drop frames in either direction, which is how the suite checks claims such as "the server cannot sit in a call".
 *
 * Every friend's console warnings, errors and uncaught exceptions are collected and fail the test at the end unless the test
 * declared them expected with `friend.expectWarning(/.../)`. That includes the invariant watchdog's `[invariant] …` warnings
 * (quality ticket 04): a test in which the UI contradicted the call fails, unless it declared `friend.expectInvariant(kind)`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { environmentNoise, launchOptions, originFor, type Autoplay, type Engine } from './browsers';

export { expect };

/** A fresh shared secret, so every test runs in rooms nobody else is in. Same shape as `newRoomSecret` in the app. */
export const newSecret = (): string => randomBytes(16).toString('base64url');

export type RoomSeed = { secret: string; name: string };

/** A frame rewriter: return the frame (changed or not) to pass it on, or null to drop it. Frames are the JSON strings on the wire. */
export type Tamper = (frame: string) => string | null;

/** The WebSocket proxy between one friend and the server. */
export class Wire {
  private routes = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();
  private refusing = false;
  /** Client to server. */
  up: Tamper | null = null;
  /** Server to client. */
  down: Tamper | null = null;
  /** Every frame seen, both directions, for assertions about what the server gets to see. */
  readonly log: Array<{ dir: 'up' | 'down'; frame: string }> = [];
  /** Sockets open to the server right now. */
  get open(): number { return this.routes.size; }

  attach(route: WebSocketRoute): void {
    if (this.refusing) { void route.close({ code: 1011, reason: 'e2e: server down' }); return; }
    const server = route.connectToServer();
    const pair = { page: route, server };
    this.routes.add(pair);
    route.onMessage((m) => {
      const frame = typeof m === 'string' ? m : m.toString();
      this.log.push({ dir: 'up', frame });
      const out = this.up ? this.up(frame) : frame;
      if (out !== null) server.send(out);
    });
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? m : m.toString();
      this.log.push({ dir: 'down', frame });
      const out = this.down ? this.down(frame) : frame;
      if (out !== null) route.send(out);
    });
    route.onClose((code, reason) => { this.routes.delete(pair); void server.close({ code, reason }); });
    server.onClose((code, reason) => { this.routes.delete(pair); void route.close({ code, reason }); });
  }

  /** The server goes away: open sockets close as if the connection dropped, and reconnects are refused until `restore`. */
  async cut(): Promise<void> {
    this.refusing = true;
    for (const { page, server } of [...this.routes]) { await server.close().catch(() => {}); await page.close({ code: 1011, reason: 'e2e: cut' }).catch(() => {}); }
    this.routes.clear();
  }

  restore(): void { this.refusing = false; }

  /** Sends a frame to the page as if the server had, e.g. one a `down` tamper held back earlier. */
  deliver(frame: string): void { for (const { page } of this.routes) page.send(frame); }

  /** Parsed frames of one type in one direction, as seen by the proxy (before tampering). */
  frames<T = Record<string, unknown>>(dir: 'up' | 'down', t?: string): T[] {
    return this.log.filter((l) => l.dir === dir).map((l) => { try { return JSON.parse(l.frame) as T & { t?: string }; } catch { return null; } })
      .filter((m): m is T & { t?: string } => m !== null && (t === undefined || m.t === t));
  }
}

/**
 * Messages that come with ordinary churn once there is real latency (seen against nightly), not with a fault:
 * - the server turns down signaling to a friend who has just left presence (leave, reload, dropped socket, rejoin)
 * - the browser reports a socket that a reload or take-over closed while it was still connecting
 * Anything else a test provokes on purpose it declares itself with `expectWarning`.
 */
const KNOWN_HARMLESS: RegExp[] = [
  /dropped signal that participant is not in the call/,
  /WebSocket is closed before the connection is established/, // Chromium
  /can’t establish a connection to the server at wss?:|was interrupted while the page was loading/, // Firefox (ws: on a local build)
];

export type FriendOptions = {
  rooms: RoomSeed[];
  /** Display name, pre-seeded so the page skips the name form. Omit to land on the first-visit form. */
  name?: string | null;
  /** Join calls muted. */
  muted?: boolean;
  viewport?: { width: number; height: number };
  /** A phone's pixel density for screenshots; default 1. */
  deviceScaleFactor?: number;
  /** Run this friend in another engine than the test's project, e.g. a Chromium sharer for a Firefox viewer. */
  engine?: Engine;
  /** Autoplay policy of this friend's browser; `blocked` is Brave's and Firefox's "Block" setting. Default: allowed. */
  autoplay?: Autoplay;
  /** Profile picture, one emoji, pre-seeded like the name. */
  picture?: string;
  /** Look like a normal browser, not "HeadlessChrome" or webdriver: posthog-js drops every event from what it takes for a bot. */
  plainUserAgent?: boolean;
  /** This browser's answer to the PostHog question (ticket 32); null leaves it unasked, so the notice shows. Default: on. */
  telemetry?: 'on' | 'off' | null;
  /** Records this friend's pages as video into this folder, at the viewport's size (CSS pixels: the screencast ignores the density). For showing a change, not for asserting. */
  video?: string;
};

export class Friend {
  readonly wire = new Wire();
  private expected: RegExp[] = [...KNOWN_HARMLESS];
  readonly problems: string[] = [];
  /** Console arguments still being read out (see `watch`); settled before the problems are judged. */
  private reading: Promise<void>[] = [];
  /** URLs of the PostHog requests this friend's pages made (answered locally, never sent). */
  readonly posthog: string[] = [];
  page!: Page;
  context!: BrowserContext;

  constructor(readonly name: string, private readonly options: FriendOptions) {}

  async launch(browser: Browser, engine: Engine): Promise<void> {
    const baseURL = originFor(engine);
    this.expected.push(...environmentNoise(engine));
    const probe = this.options.plainUserAgent ? await browser.newPage() : null;
    const userAgent = probe ? (await probe.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome') : undefined;
    await probe?.close();
    // Contexts made by hand do not inherit the config's `use`, so the target URL is passed on explicitly.
    this.context = await browser.newContext({ baseURL, viewport: this.options.viewport ?? { width: 1200, height: 800 }, ...(this.options.deviceScaleFactor ? { deviceScaleFactor: this.options.deviceScaleFactor } : {}), ...(userAgent ? { userAgent } : {}), ...(this.options.video ? { recordVideo: { dir: this.options.video, size: this.options.viewport ?? { width: 1200, height: 800 } } } : {}) });
    // Nothing goes to PostHog from a test: answer its requests locally so the SDK stays quiet and nothing is recorded.
    // What would have gone is kept, so a test can check that an event was sent.
    await this.context.route(/posthog\.com/, (r) => { this.posthog.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    await this.context.routeWebSocket(/\/ws\//, (ws) => this.wire.attach(ws));
    // posthog-js also takes navigator.webdriver (set by Playwright) and a "HeadlessChrome" brand in userAgentData for a bot.
    if (this.options.plainUserAgent) {
      await this.context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
        Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
      });
    }
    // Seed storage once per context, before the app reads it. Later reloads keep whatever the app changed.
    await this.context.addInitScript((seed) => {
      if (localStorage.getItem('dave.e2e-seeded')) return;
      localStorage.setItem('dave.e2e-seeded', '1');
      localStorage.setItem('dave.test', 'true');
      localStorage.setItem('dave.rooms', JSON.stringify(seed.rooms.map((r, i) => ({ ...r, addedAt: Date.now() + i }))));
      if (seed.rooms[0]) localStorage.setItem('dave.room', seed.rooms[0].secret);
      if (seed.name) localStorage.setItem('dave.name', seed.name);
      if (seed.muted) localStorage.setItem('dave.muted', 'true');
      if (seed.picture) localStorage.setItem('dave.picture', seed.picture);
      if (seed.telemetry) localStorage.setItem('dave.telemetry', seed.telemetry);
    }, { telemetry: this.options.telemetry === undefined ? 'on' : this.options.telemetry, rooms: this.options.rooms, name: this.options.name === undefined ? this.name : this.options.name, muted: !!this.options.muted, picture: this.options.picture ?? null });
    // Every oscillator a page starts is recorded as "type Hz", so a test can tell which cue played (ticket 23).
    await this.context.addInitScript(() => {
      const played: string[] = [];
      (window as unknown as { __cuesPlayed: string[] }).__cuesPlayed = played;
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (this: OscillatorNode, ...a: [number?]) { played.push(`${this.type} ${Math.round(this.frequency.value)}`); return start.apply(this, a); };
    });
    this.page = await this.context.newPage();
    this.watch(this.page);
  }

  /** Collects console warnings, errors and exceptions of a page of this friend. */
  watch(page: Page): void {
    page.on('console', (m) => {
      if (m.type() !== 'warning' && m.type() !== 'error') return;
      const i = this.problems.push(`${m.type()}: ${m.text()}`) - 1;
      // Firefox gives an error object as "JSHandle@object", which says nothing about the failure: read it out, so a
      // flake's report names the error (ticket 35). Patterns still match: the message's own text comes first.
      if (m.text().includes('JSHandle@')) {
        this.reading.push(Promise.all(m.args().map((a) => a.evaluate((v) => (v && typeof v === 'object' && 'message' in v ? `${(v as Error).name}: ${(v as Error).message}` : typeof v === 'object' ? JSON.stringify(v) : String(v)))))
          .then((parts) => { this.problems[i] = `${m.type()}: ${parts.join(' ')}`; }, () => {}));
      }
    });
    page.on('pageerror', (e) => this.problems.push(`exception: ${e.message}`));
  }

  /** Declares console output this test provokes on purpose, so it does not fail the test. */
  expectWarning(pattern: RegExp): void { this.expected.push(pattern); }
  /** Declares an invariant this test breaks on purpose (client/invariants.ts), so its report does not fail the test. */
  expectInvariant(kind: string): void { this.expected.push(new RegExp(`^warning: \\[invariant\\] ${kind} `)); }
  async unexpectedProblems(): Promise<string[]> {
    await Promise.all(this.reading);
    return this.problems.filter((p) => !this.expected.some((re) => re.test(p)));
  }

  /** Opens the app and waits until the selected room is connected (the composer is enabled). */
  async open(path = '/'): Promise<this> {
    await this.page.goto(path);
    await this.connected();
    return this;
  }

  async connected(): Promise<void> { await expect(this.composer).toBeEnabled(); }

  // --- the page, as a friend sees it ---
  get composer(): Locator { return this.page.locator('.chat-input > input'); }
  get banner(): Locator { return this.page.locator('.banner'); }
  get selectedRoom(): Locator { return this.page.locator('section.room.selected'); }
  /** Names in the Online list, "(you)" stripped. */
  async online(): Promise<string[]> { return (await this.page.locator('aside.side > ul.plist .nm').allInnerTexts()).map(clean); }
  /** Names in the selected room's call list, "(you)" stripped. */
  async inCall(): Promise<string[]> { return (await this.selectedRoom.locator('li.prow .nm').allInnerTexts()).map(clean); }
  /** Chat lines of the room on screen: sender and text, system lines left out. A follow-on line has no name of its own and takes the one above. */
  async chat(): Promise<Array<{ from: string; text: string }>> {
    return this.page.locator('.chat-log .msg:not(.msg-sys)').evaluateAll((els) => {
      let from = '';
      return els.map((e) => {
        const own = e.querySelector('.msg-from');
        if (own) from = (own.firstChild?.textContent ?? '').trim();
        return { from, text: (e.querySelector('.msg-text') as HTMLElement | null)?.innerText.trim() ?? '' };
      });
    });
  }
  async chatTexts(): Promise<string[]> { return (await this.chat()).map((l) => l.text); }

  /**
   * Sends a text and waits for it to come back from the server, which shows every line, your own too, in the order the Room
   * took them: whatever anyone sends afterwards comes after it. An empty composer alone does not say that (ticket 35, flake 4).
   */
  async say(text: string): Promise<void> {
    const copies = async () => (await this.chatTexts()).filter((t) => t === text).length;
    const before = await copies();
    await this.composer.fill(text);
    await this.composer.press('Enter');
    await expect(this.composer).toHaveValue('');
    await expect.poll(copies, { message: `${this.name}'s "${text}" comes back from the server` }).toBeGreaterThan(before);
  }

  async selectRoom(name: string): Promise<void> {
    await this.page.locator('button.room-name', { hasText: name }).click();
    await expect(this.selectedRoom.locator('.room-title')).toHaveText(name);
  }

  async join(): Promise<void> {
    await this.selectedRoom.locator('button.join').click();
    await expect(this.selectedRoom.locator('button.leave')).toBeVisible();
  }

  async leave(): Promise<void> {
    await this.selectedRoom.locator('button.leave').click();
    await expect(this.selectedRoom.locator('button.join')).toBeVisible();
  }

  /** The connection badge this friend shows for another participant in the call list. */
  badge(of: string): Locator { return this.selectedRoom.locator('li.prow', { has: this.page.locator('.nm', { hasText: new RegExp(`^${escape(of)}$`) }) }).locator('.conn'); }

  /** Waits until every other named participant shows a direct (or relayed) connection. */
  /** The share tile for one sharer, as this friend sees it. */
  tile(of: string): Locator { return this.page.locator('.share', { has: this.page.locator('.share-head', { hasText: of }) }); }
  button(name: string | RegExp): Locator { return this.selectedRoom.getByRole('button', { name, exact: typeof name === 'string' }); }
  async startShare(): Promise<void> { await this.button('Share screen').click(); await expect(this.button('Stop sharing')).toBeVisible(); }
  async stopShare(): Promise<void> { await this.button('Stop sharing').click(); await expect(this.button('Share screen')).toBeVisible(); }
  /** Clicks a share tile to watch it and waits for the picture. */
  async watchShare(of: string): Promise<void> {
    await this.tile(of).click();
    await expect(this.tile(of)).toHaveClass(/share-live/);
    await expect.poll(() => this.tile(of).locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { message: `${this.name} sees ${of}'s picture` }).toBeGreaterThan(0);
  }

  async connectedTo(...names: string[]): Promise<void> {
    for (const n of names) await expect(this.badge(n)).toHaveText(/^(direct|via relay)$/);
  }

  // --- inspection hooks (dev server and e2e build only) ---
  async hasHooks(): Promise<boolean> { return this.page.evaluate(() => '__dave' in window); }
  /** `window.__dave.peers()`: per-peer state of the call joined last. */
  async peers(): Promise<Array<{ name: string; conn: string; audioBytesIn: number; videoBytesIn: number; shareLive: boolean; watching: boolean; relayOnly: boolean; subscribedToMe: boolean }>> {
    return this.page.evaluate(() => (window as unknown as { __dave?: { peers: () => never[] } }).__dave?.peers() ?? []);
  }
  /** Calls any other inspection hook by name, e.g. `hook('share')`, `hook('volumes')`, `hook('dropSocket')`. */
  async hook<T = any>(name: string, ...args: unknown[]): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.page.evaluate(([n, a]) => (window as unknown as { __dave: Record<string, (...x: unknown[]) => unknown> }).__dave[n as string]!(...(a as unknown[])), [name, args] as const) as Promise<T>;
  }
  /** The invariants the watchdog reported in this friend's page, in order (quality ticket 04). */
  async invariants(): Promise<Array<{ kind: string; heldMs: number; snapshot: Record<string, unknown> }>> { return this.hook('invariants'); }
  /** Share video bytes received from one sharer so far. */
  async videoBytesFrom(name: string): Promise<number> { return (await this.peers()).find((p) => p.name === name)?.videoBytesIn ?? 0; }
  /** Whether share video from `name` is still arriving: bytes grow over `ms`. */
  async receivingShareFrom(name: string, ms = 3000): Promise<boolean> {
    const before = await this.videoBytesFrom(name);
    await this.page.waitForTimeout(ms);
    return (await this.videoBytesFrom(name)) - before > 20_000;
  }
  /** The oscillators started since the last call, as "type Hz": the cue that just played. */
  async cuesPlayed(): Promise<string[]> { return this.page.evaluate(() => (window as unknown as { __cuesPlayed: string[] }).__cuesPlayed.splice(0)); }
  async cues(): Promise<number> { return this.page.evaluate(() => (window as unknown as { __daveCues?: () => number }).__daveCues?.() ?? -1); }

  /** Waits until audio from every named peer has been flowing for a moment (bytes received keep growing). */
  async hearing(...names: string[]): Promise<void> {
    const bytes = async () => Object.fromEntries((await this.peers()).map((p) => [p.name, p.audioBytesIn]));
    await expect.poll(async () => { const b = await bytes(); return names.every((n) => (b[n] ?? 0) > 0); }, { message: `${this.name} hears ${names.join(', ')}` }).toBe(true);
    const before = await bytes();
    await expect.poll(async () => { const b = await bytes(); return names.every((n) => (b[n] ?? 0) > (before[n] ?? 0)); }, { message: `audio keeps flowing to ${this.name}` }).toBe(true);
  }

  // The context is missing when the launch itself failed; teardown must not hide that error.
  async close(): Promise<void> { await this.context?.close().catch(() => {}); }
}

const clean = (s: string) => s.replace(/\s*\(you\)\s*$/, '').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A video receipt (playwright.receipts.config.ts, .github/workflows/receipts.yml): the first friend a test opens is filmed at
 * this viewport, unless the test gives that friend a viewport of its own, and the video lands in `dir` named after the test.
 * Null, the default, in the normal suite.
 */
export type Film = { viewport: { width: number; height: number }; dir: string } | null;

/** The file name a receipt gets: its spec file, then its test's title, lower case, words joined by dashes, the tag left out. */
export const filmName = (file: string, title: string): string => {
  const slug = (s: string) => s.replace(/@\w+/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(basename(file).replace(/\.spec\.ts$/, ''))}--${slug(title).slice(0, 80)}`;
};

type Crowd = {
  /** Opens a friend in the given rooms (default: one room shared by the test) and waits until connected. */
  open(name: string, options?: Partial<FriendOptions> & { connect?: boolean }): Promise<Friend>;
  /** The room every friend lands in unless told otherwise. */
  room: RoomSeed;
};

export const test = base.extend<{ crowd: Crowd; film: Film }>({
  film: [null, { option: true }],
  crowd: async ({ browser, browserName, playwright, film }, use, testInfo) => {
    const friends: Friend[] = [];
    const room: RoomSeed = { secret: newSecret(), name: 'Room' };
    // Extra browsers (another engine, another autoplay policy), launched on first use and closed with the test.
    const extra = new Map<string, Promise<Browser>>();
    // Seconds from the start of the film until its friend's page is up: the blank page before that is cut from the receipt.
    let filmReady = 0;
    const browserFor = (o: Partial<FriendOptions>): Promise<Browser> => {
      const engine = o.engine ?? (browserName as Engine);
      const autoplay = o.autoplay ?? 'allowed';
      if (engine === browserName && autoplay === 'allowed') return Promise.resolve(browser);
      const key = `${engine}-${autoplay}`;
      if (!extra.has(key)) extra.set(key, playwright[engine].launch(launchOptions(engine, { autoplay })));
      return extra.get(key)!;
    };
    await use({
      room,
      async open(name, options = {}) {
        const filming = film && friends.length === 0;
        if (filming) options = { viewport: film.viewport, ...options, video: testInfo.outputPath('film') };
        const friend = new Friend(name, { ...options, rooms: options.rooms ?? [room] });
        friends.push(friend);
        const started = Date.now();
        await friend.launch(await browserFor(options), options.engine ?? (browserName as Engine));
        if (options.connect !== false) await friend.open();
        if (filming) filmReady = (Date.now() - started) / 1000;
        return friend;
      },
    });
    const problems = (await Promise.all(friends.map(async (f) => (await f.unexpectedProblems()).map((p) => `${f.name}: ${p}`)))).flat();
    // A failed test keeps each friend's socket frames and peer state next to its trace: what the server saw and relayed.
    // So does one about to fail on its console alone: a refused frame is told only by its error (nightly, 2026-10-10).
    if (testInfo.status !== testInfo.expectedStatus || problems.length) {
      for (const f of friends) {
        const peers = await f.peers().catch(() => null);
        writeFileSync(testInfo.outputPath(`${f.name}-wire.json`), JSON.stringify({ peers, problems: f.problems, frames: f.wire.log }, null, 1));
      }
    }
    if (problems.length) await testInfo.attach('console problems', { body: problems.join('\n'), contentType: 'text/plain' });
    await Promise.all(friends.map((f) => f.close()));
    await Promise.all([...extra.values()].map(async (b) => (await b).close()));
    // The video is complete once its context is closed. A failed run is kept too: it shows how far the change got.
    const filmed = film && friends[0]?.page?.video();
    if (filmed) {
      const name = filmName(testInfo.file, testInfo.title);
      mkdirSync(film.dir, { recursive: true });
      await filmed.saveAs(join(film.dir, `${name}.webm`));
      writeFileSync(join(film.dir, `${name}.json`), JSON.stringify({ title: testInfo.title.replace(/\s*@\w+/g, ''), skip: filmReady, status: testInfo.status === testInfo.expectedStatus && !problems.length ? 'passed' : 'failed' }));
    }
    expect(problems, 'console warnings, errors or exceptions nobody expected').toEqual([]);
  },
});

/** Skips the current test when the app under test was built without the inspection hooks (a deployed copy). */
export async function needHooks(friend: Friend): Promise<void> {
  test.skip(!(await friend.hasHooks()), 'needs the inspection hooks: run against the e2e build, not a deployed copy');
}
