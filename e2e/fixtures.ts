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
import { writeFileSync } from 'node:fs';
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { environmentNoise, launchOptions, originFor, type Autoplay, type Engine } from './browsers';

export { expect };

/** A fresh shared secret, so every test runs in rooms nobody else is in. Same shape as `newRoomSecret` in the app. */
export const newSecret = (): string => randomBytes(16).toString('base64url');

export type RoomSeed = { secret: string; name: string };

/**
 * A frame rewriter: return the frame (changed or not) to pass it on, or null to drop it. Frames are the JSON strings on the wire.
 * `pass` sends a frame on later, along the socket this one came on (nothing once that socket is closed): a frame held back
 * and let go, as a slow server would send it.
 */
export type Tamper = (frame: string, pass: (frame: string) => void) => string | null;

/** The WebSocket proxy between one friend and the server. */
export class Wire {
  private routes = new Set<{ page: WebSocketRoute; server: WebSocketRoute; closing: boolean; severed: boolean }>();
  private refusing = false;
  /**
   * This many of the next sockets open and are never answered, as when the upgrade or the handshake hangs somewhere on the
   * way to the Room (nightly, ticket 48): no challenge comes, and nothing closes them.
   */
  unanswered = 0;
  /** Client to server. */
  up: Tamper | null = null;
  /** Server to client. */
  down: Tamper | null = null;
  /** Every frame seen, both directions, for assertions about what the server gets to see. */
  readonly log: Array<{ dir: 'up' | 'down'; frame: string }> = [];
  /**
   * Every socket's end: the side that closed it first, when, and how long the log was then (where it falls among the frames).
   * A server side closed with 1006 on a socket that was let in is the network dropping it (seen against nightly and the
   * previews, ticket 51), not the Room, which closes with a code of its own.
   */
  readonly closes: Array<{ side: 'page' | 'server'; code?: number; reason?: string; at: number; frames: number }> = [];
  /** Sockets open to the server right now. */
  get open(): number { return this.routes.size; }
  /** Whether the network dropped a socket (see `closes`) at or after this time (`Date.now()`). */
  droppedSince(at: number): boolean { return this.closes.some((c) => c.side === 'server' && c.code === 1006 && c.at >= at); }

  attach(route: WebSocketRoute): void {
    if (this.refusing) { void route.close({ code: 1011, reason: 'e2e: server down' }); return; }
    // Not connected to the server, the page's socket opens all the same (Playwright's mock) and hears nothing.
    if (this.unanswered > 0) { this.unanswered--; return; }
    const server = route.connectToServer();
    const pair = { page: route, server, closing: false, severed: false };
    this.routes.add(pair);
    // The socket to the server lives in the page (Playwright's routeWebSocket). Once one side closes, a frame still on its
    // way is lost with the connection, as on a real drop: written to the closing socket, it made Chromium log "WebSocket is
    // already in CLOSING or CLOSED state." in the friend's console, a line the app itself never causes (ticket 41).
    route.onMessage((m) => {
      const frame = typeof m === 'string' ? m : m.toString();
      this.log.push({ dir: 'up', frame });
      if (pair.severed) return;
      const out = this.up ? this.up(frame, (f) => { if (!pair.closing) server.send(f); }) : frame;
      if (out !== null && !pair.closing) server.send(out);
    });
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? m : m.toString();
      this.log.push({ dir: 'down', frame });
      if (pair.severed) return;
      const out = this.down ? this.down(frame, (f) => { if (!pair.closing) route.send(f); }) : frame;
      if (out !== null) route.send(out);
    });
    const ended = (side: 'page' | 'server', code?: number, reason?: string) => {
      // Each end of a severed socket closes on its own, unheard by the other: both are recorded.
      if (!pair.closing || pair.severed) this.closes.push({ side, code, reason, at: Date.now(), frames: this.log.length });
    };
    // A severed socket's close reaches neither end either: each side finds out on its own.
    route.onClose((code, reason) => { ended('page', code, reason); pair.closing = true; this.routes.delete(pair); if (!pair.severed) void server.close({ code, reason }); });
    server.onClose((code, reason) => { ended('server', code, reason); pair.closing = true; this.routes.delete(pair); if (!pair.severed) void route.close({ code, reason }); });
  }

  /** The server goes away: open sockets close as if the connection dropped, and reconnects are refused until `restore`. */
  async cut(): Promise<void> {
    this.refusing = true;
    for (const pair of [...this.routes]) {
      // Before the first await: the server side is closing from here on, with the page's side still open a moment longer.
      pair.closing = true;
      await pair.server.close().catch(() => {});
      await pair.page.close({ code: 1011, reason: 'e2e: cut' }).catch(() => {});
    }
    this.routes.clear();
  }

  /**
   * The network cuts the open sockets without a word to either end, as in the field (ticket 54): from here on no frame and
   * no close crosses them. The Room keeps its side and writes into it until it closes it itself (a supersede, its silence
   * sweep), and the page's side stays open until the app gives it up. Unlike `cut`, new sockets get through.
   */
  sever(): void { for (const pair of this.routes) pair.severed = true; }

  restore(): void { this.refusing = false; }

  /**
   * The tab goes away and says so on its open sockets, as a closed tab does, and waits a moment for the Room to answer.
   * Closing the context alone left that to the browser: the socket to the server lives in the page, the route reports it
   * closed as the page goes, and the close sent on to the server then has no page left to go out from. Firefox at times
   * kept the socket open after its context closed, and the Room listed the friend until its sweep (ticket 59). A severed
   * socket stays severed: its tab dies unheard. Page JS can close with 1000, not with a tab's 1001. The page is not told,
   * as a tab on its way out is not, so the app does not reconnect in the moment left; nor would a reconnect get through.
   */
  async goAway(): Promise<void> {
    this.refusing = true;
    const open = [...this.routes].filter((p) => !p.severed && !p.closing);
    for (const pair of open) { pair.severed = true; await pair.server.close({ code: 1000, reason: 'e2e: tab closed' }).catch(() => {}); }
    for (let waited = 0; open.some((p) => this.routes.has(p)) && waited < 2_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  }

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
  /**
   * Holds this friend's share video to a trickle for its first `ms` after a viewer asks for it (1 frame a second, a
   * quarter of the size, 30 kbps), then lets it go as the app set it. What Chromium's own bandwidth estimate can do to a
   * share that starts right after its connection came up: 30 to 75 kbps for about 2.3 s, seen with a Firefox viewer
   * against nightly (ticket 46).
   */
  slowShareStart?: number;
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
    // What would have gone is kept, so a test can check that an event was sent. The app sends through its own Worker
    // (`/diag/`, worker/posthog.ts); a request straight to posthog.com is caught too, so a test can tell it happened.
    await this.context.route(/posthog\.com|\/diag\//, (r) => { this.posthog.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
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
    if (this.options.slowShareStart) {
      await this.context.addInitScript((ms) => {
        const set = RTCRtpSender.prototype.setParameters;
        /** What the app asked of each held sender, applied once the hold ends. */
        const asked = new Map<RTCRtpSender, RTCRtpEncodingParameters>();
        let until = 0;
        const release = (s: RTCRtpSender, a: RTCRtpEncodingParameters) => {
          const p = s.getParameters();
          if (!p.encodings?.[0]) return; // the share or the connection is gone
          Object.assign(p.encodings[0], a);
          // The app's own call may be under way; any other error means the sender is closed.
          set.call(s, p).catch((e: DOMException) => { if (e.name === 'InvalidModificationError') setTimeout(() => release(s, a), 100); });
        };
        RTCRtpSender.prototype.setParameters = function (this: RTCRtpSender, p: RTCRtpSendParameters, ...rest: unknown[]) {
          const e = p.encodings?.[0];
          if (this.track?.kind === 'video' && e?.active) {
            if (!until) {
              until = Date.now() + ms;
              setTimeout(() => { for (const [s, a] of asked) release(s, a); asked.clear(); }, ms);
            }
            if (Date.now() < until) {
              asked.set(this, { maxBitrate: e.maxBitrate, maxFramerate: e.maxFramerate, scaleResolutionDownBy: e.scaleResolutionDownBy });
              Object.assign(e, { maxBitrate: 30_000, maxFramerate: 1, scaleResolutionDownBy: 4 });
            } else asked.delete(this); // a late release must not undo what the app asked since
          }
          return (set as (...a: unknown[]) => Promise<void>).call(this, p, ...rest);
        };
      }, this.options.slowShareStart);
    }
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

  /**
   * Waits until the selected room is connected: the composer is enabled and no banner says the server is away. The composer
   * alone no longer says it: it stays enabled while the app reconnects, and a text written then waits (ticket 10).
   */
  async connected(timeout?: number): Promise<void> {
    await expect(this.composer).toBeEnabled({ timeout });
    await expect(this.away).toHaveCount(0, { timeout });
  }

  /** Whether the selected room is connected right now (see `connected`). */
  async isConnected(): Promise<boolean> { return await this.composer.isEnabled() && await this.away.count() === 0; }

  // --- the page, as a friend sees it ---
  get composer(): Locator { return this.page.locator('.chat-field > input'); }
  get sendButton(): Locator { return this.page.locator('form.chat-input').getByRole('button', { name: 'Send', exact: true }); }
  /** Files staged above the composer, waiting for Send. */
  get staged(): Locator { return this.page.locator('.staged > li'); }
  get banner(): Locator { return this.page.locator('.banner'); }
  /** The banner while the room's socket is away or not let in yet. */
  get away(): Locator { return this.banner.filter({ hasText: /Connecting|Reconnecting|Server unavailable/ }); }
  get selectedRoom(): Locator { return this.page.locator('section.room.selected'); }
  /**
   * Names of everyone in the room on screen and not in its call, as the sidebar lists them (a friend in another room's call
   * too): friends newest first, then me, unless I am in a call (or this tab holds no place in the room). Another room's
   * people are faces beside its name, not listed.
   */
  async online(): Promise<string[]> {
    // Not deduplicated: a friend listed twice is a bug these lists must show.
    return (await this.page.locator('aside.side ul.plist.visitors .nm').allInnerTexts()).map(clean);
  }
  /**
   * Names of everyone the sidebar shows, wherever: in the lists of the room on screen, its call box, or as a face beside
   * the name of another room (a face's title starts with the name).
   */
  async seen(): Promise<string[]> {
    const listed = (await this.page.locator('aside.side ul.plist .nm').allInnerTexts()).map(clean);
    const faces = await this.page.locator('aside.side .roomfaces .avatar').evaluateAll((els) => els.map((e) => (e.getAttribute('title') ?? '').split(/[.,]/)[0]!.trim()));
    return [...listed, ...faces];
  }
  /** As settledOnline, for names shown anywhere in the sidebar (`seen`): a friend in another room only is a face there. */
  async settledSeen(...names: string[]): Promise<void> {
    await expect.poll(async () => { const seen = await this.seen(); return names.filter((n) => !seen.includes(n)); }, { message: `${this.name} shows ${names.join(', ')}` }).toEqual([]);
    await expect.poll(() => this.page.locator('aside.side').evaluate((side) => [...side.querySelectorAll('ul.plist.visitors')].flatMap((ul) => ul.getAnimations({ subtree: true })).filter((a) => a.effect?.getTiming().iterations !== Infinity).length), { message: `${this.name}'s lists stop moving` }).toBe(0);
  }
  /**
   * Waits until the Online list holds these names and has stopped moving: a row slides in over 460 ms, after up to 400 ms
   * (`open` in App.tsx), and a click that Playwright found stable can still land where the row pushed it from. Endless
   * animations (a speaking glow, a spinner) never stop, and move nothing: they do not count.
   */
  async settledOnline(...names: string[]): Promise<void> {
    await expect.poll(async () => { const online = await this.online(); return names.filter((n) => !online.includes(n)); }, { message: `${this.name} lists ${names.join(', ')}` }).toEqual([]);
    await expect.poll(() => this.page.locator('aside.side').evaluate((side) => [...side.querySelectorAll('ul.plist.visitors')].flatMap((ul) => ul.getAnimations({ subtree: true })).filter((a) => a.effect?.getTiming().iterations !== Infinity).length), { message: `${this.name}'s Online list stops moving` }).toBe(0);
  }

  /** Names in the selected room's call list, "(you)" stripped. */
  async inCall(): Promise<string[]> { return (await this.selectedRoom.locator('li.prow .nm').allInnerTexts()).map(clean); }
  /**
   * Chat lines of the room on screen: sender and text, system lines left out, and my own texts the Room has not brought back
   * yet (`pendingTexts`). A follow-on line has no name of its own and takes the one above.
   */
  async chat(): Promise<Array<{ from: string; text: string }>> {
    return this.page.locator('.chat:not(.private) .chat-log .msg:not(.msg-sys)').evaluateAll((els) => {
      let from = '';
      return els.flatMap((e) => {
        const own = e.querySelector('.msg-from');
        if (own) from = (own.firstChild?.textContent ?? '').trim();
        return e.classList.contains('msg-pending') ? [] : [{ from, text: (e.querySelector('.msg-text') as HTMLElement | null)?.innerText.trim() ?? '' }];
      });
    });
  }
  async chatTexts(): Promise<string[]> { return (await this.chat()).map((l) => l.text); }
  /** My own texts in the chat that the Room has not brought back yet, shown as waiting. */
  async pendingTexts(): Promise<string[]> { return (await this.page.locator('.chat:not(.private) .chat-log .msg-pending .msg-text').allInnerTexts()).map((t) => t.trim()); }
  /**
   * The texts this browser has written to its chat history (IndexedDB, client/history.ts), every room's in turn. A line
   * shows before its write ends, and a reload in between loses it, a gap ticket 35 accepts: before a reload that a test
   * expects to keep the lines, wait for them here (ticket 43).
   */
  async storedTexts(): Promise<string[]> {
    return this.page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dave'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        const store = db.transaction('kv', 'readonly').objectStore('kv');
        const all = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
          const keys = store.getAllKeys(), values = store.getAll();
          values.onsuccess = () => resolve({ keys: keys.result, values: values.result });
          values.onerror = () => reject(values.error);
        });
        return all.keys.flatMap((k, i) => (String(k).startsWith('history:') ? (all.values[i] as Array<{ text: string }>).map((m) => m.text) : []));
      } finally { db.close(); }
    });
  }

  /**
   * Sends a text and waits for it to come back from the server, which shows every line, your own too, in the order the Room
   * took them: whatever anyone sends afterwards comes after it. An empty composer alone does not say that (ticket 35, flake 4).
   */
  async say(text: string): Promise<void> {
    const copies = async () => (await this.chatTexts()).filter((t) => t === text).length;
    const before = await copies();
    // The wire hears of a drop a moment before the page does: one just before this call can still disable the composer.
    const since = Date.now() - 2000;
    await this.composer.fill(text);
    await this.composer.press('Enter');
    // A socket the network drops (ticket 51) between the fill and the Enter disables the composer, which keeps the text and
    // sends nothing, as it does while disconnected. A friend presses Enter again once it is back, and so does this, only
    // after a drop: a text still in the enabled composer then is one that was never sent (ticket 53).
    await expect.poll(async () => {
      let value = await this.composer.inputValue();
      if (value === text && this.wire.droppedSince(since) && await this.composer.isEnabled()) {
        await this.composer.press('Enter');
        value = await this.composer.inputValue();
      }
      return value;
    }, { message: `${this.name}'s composer empties` }).toBe('');
    await expect.poll(copies, { message: `${this.name}'s "${text}" comes back from the server` }).toBeGreaterThan(before);
  }

  /** Picks files with the attach button and sends them, as a person does: they wait above the composer for Send. */
  async attach(files: Parameters<Locator['setInputFiles']>[0]): Promise<void> {
    await this.page.getByTestId('attach').setInputFiles(files);
    await this.sendButton.click();
    await expect(this.staged).toHaveCount(0);
  }

  /** Brings a room on screen, open in the sidebar; not a click on it when it is so already, which would fold it. */
  async selectRoom(name: string): Promise<void> {
    const open = this.page.locator('section.room.selected:not(.folded) .room-title');
    if (!(await open.allTextContents()).some((t) => t.trim() === name)) await this.page.locator('button.room-name', { hasText: name }).click();
    await expect(open).toHaveText(name);
  }

  async join(): Promise<void> {
    await this.press(this.selectedRoom.locator('button.join'));
    await expect(this.selectedRoom.locator('button.leave')).toBeVisible();
  }

  async leave(): Promise<void> {
    await this.press(this.selectedRoom.locator('button.leave'));
    await expect(this.selectedRoom.locator('button.join')).toBeVisible();
  }

  /**
   * Clicks Join or Leave, whose place moves whenever a friend's row comes or goes in the lists above it: Bob's Leave hit
   * the call list as Alice's row left it (PR #68's preview, 2026-10-16, ticket 57). Only a click the button itself never
   * got is made again; one it got and the app then did nothing with still fails the test, at the caller's wait.
   */
  private async press(button: Locator): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const target = await button.elementHandle();
      await target?.evaluate((el) => { (el as HTMLElement & { e2eClicked?: boolean }).e2eClicked = false; el.addEventListener('click', () => { (el as HTMLElement & { e2eClicked?: boolean }).e2eClicked = true; }, { once: true }); });
      await button.click();
      const hit = await target?.evaluate((el) => (el as HTMLElement & { e2eClicked?: boolean }).e2eClicked).catch(() => true);
      if (hit !== false) return;
    }
  }

  /** The connection badge this friend shows for another participant in the call list. */
  badge(of: string): Locator { return this.selectedRoom.locator('li.prow', { has: this.page.locator('.nm', { hasText: new RegExp(`^${escape(of)}$`) }) }).locator('.conn'); }

  /** Waits until every other named participant shows a direct (or relayed) connection. */
  /** The share tile for one sharer, as this friend sees it. */
  tile(of: string): Locator { return this.page.locator('.share', { has: this.page.locator('.share-head', { hasText: of }) }); }
  button(name: string | RegExp): Locator { return this.selectedRoom.getByRole('button', { name, exact: typeof name === 'string' }); }
  /**
   * What this friend's next shares carry for sound, whatever the browser's fake capture gives: the fake microphone's beep
   * (as a shared tab with sound), or nothing (as a shared window).
   */
  async shareSound(on: boolean): Promise<void> {
    await this.page.evaluate((on) => {
      const media = navigator.mediaDevices;
      const capture = media.getDisplayMedia.bind(media);
      media.getDisplayMedia = async (options) => {
        const stream = await capture(options);
        for (const t of stream.getAudioTracks()) { stream.removeTrack(t); t.stop(); }
        if (on) stream.addTrack((await media.getUserMedia({ audio: true })).getAudioTracks()[0]!);
        return stream;
      };
    }, on);
  }
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

  /**
   * Makes this page's IndexedDB slow until the page goes: every database it opens from now on answers `ms` later, as
   * Firefox's sometimes does on a busy CI runner. A history write (client/history.ts) then ends well after its line shows
   * (ticket 43). The app opens the database for each read and write (client/storage.ts), so every one of them waits.
   */
  async slowStorage(ms: number): Promise<void> {
    await this.page.evaluate((delay) => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (this: IDBFactory, ...a: [string, number?]) {
        const req = open.apply(this, a);
        // Registered before the app sets `onsuccess`, so it runs first: hold the event back and hand it on later.
        req.addEventListener('success', (e) => {
          e.stopImmediatePropagation();
          setTimeout(() => req.dispatchEvent(new Event('success')), delay);
        }, { once: true });
        return req;
      };
    }, ms);
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
  async close(): Promise<void> {
    await this.wire.goAway();
    await this.context?.close().catch(() => {});
  }
}

const clean = (s: string) => s.replace(/\s*\(you\)\s*$/, '').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Crowd = {
  /** Opens a friend in the given rooms (default: one room shared by the test) and waits until connected. */
  open(name: string, options?: Partial<FriendOptions> & { connect?: boolean }): Promise<Friend>;
  /** The room every friend lands in unless told otherwise. */
  room: RoomSeed;
};

export const test = base.extend<{ crowd: Crowd }>({
  crowd: async ({ browser, browserName, playwright }, use, testInfo) => {
    const friends: Friend[] = [];
    const room: RoomSeed = { secret: newSecret(), name: 'Room' };
    // Extra browsers (another engine, another autoplay policy), launched on first use and closed with the test.
    const extra = new Map<string, Promise<Browser>>();
    const browserFor = (o: Partial<FriendOptions>): Promise<Browser> => {
      const engine = o.engine ?? (browserName as Engine);
      const autoplay = o.autoplay ?? 'allowed';
      if (engine === browserName && autoplay === 'allowed') return Promise.resolve(browser);
      const key = `${engine}-${autoplay}`;
      if (!extra.has(key)) extra.set(key, playwright[engine].launch(launchOptions(engine, { autoplay })));
      return extra.get(key)!;
    };
    /** Friends let in so far, with the secrets of their rooms. */
    const opened: Array<{ friend: Friend; secrets: string[] }> = [];
    await use({
      room,
      async open(name, options = {}) {
        const friend = new Friend(name, { ...options, rooms: options.rooms ?? [room] });
        friends.push(friend);
        await friend.launch(await browserFor(options), options.engine ?? (browserName as Engine));
        if (options.connect !== false) {
          await friend.open();
          // Everyone connected in a room of the newcomer's lists them, and they list everyone, before the test goes on: a
          // row arriving in the Online list moves what is below it, the Join button too, and a click in that moment lands
          // beside it. Alice's Join hit "nobody in the call" as Bob's row came in (nightly, 2026-10-16, Firefox, ticket 57).
          const secrets = (options.rooms ?? [room]).map((r) => r.secret);
          const peers: Friend[] = [];
          for (const o of opened) {
            if (!o.secrets.some((x) => secrets.includes(x))) continue;
            // A friend without a composer (a form, a step-back screen) is not in the room: isConnected would wait for one.
            if ((await o.friend.composer.count().catch(() => 0)) > 0 && (await o.friend.isConnected().catch(() => false))) peers.push(o.friend);
          }
          // Shown, not only listed: a friend in a room of mine that is not on screen is a face beside its name.
          for (const f of peers) await f.settledSeen(name);
          await friend.settledSeen(...peers.map((f) => f.name));
          opened.push({ friend, secrets });
        }
        return friend;
      },
    });
    const problems = (await Promise.all(friends.map(async (f) => (await f.unexpectedProblems()).map((p) => `${f.name}: ${p}`)))).flat();
    // A failed test keeps each friend's socket frames and peer state next to its trace: what the server saw and relayed.
    // So does one about to fail on its console alone: a refused frame is told only by its error (nightly, 2026-10-10).
    if (testInfo.status !== testInfo.expectedStatus || problems.length) {
      for (const f of friends) {
        const peers = await f.peers().catch(() => null);
        writeFileSync(testInfo.outputPath(`${f.name}-wire.json`), JSON.stringify({ peers, problems: f.problems, closes: f.wire.closes, frames: f.wire.log }, null, 1));
      }
    }
    if (problems.length) await testInfo.attach('console problems', { body: problems.join('\n'), contentType: 'text/plain' });
    await Promise.all(friends.map((f) => f.close()));
    await Promise.all([...extra.values()].map(async (b) => (await b).close()));
    expect(problems, 'console warnings, errors or exceptions nobody expected').toEqual([]);
  },
});

/** Opens the sidebar's ⚙ menu (new room, join by link, theme, report a problem…), if it is not open already. */
export async function openMenu(page: Page): Promise<void> {
  if (await page.locator('#side-menu:popover-open').count()) return;
  await page.locator('aside.side button.gear[popovertarget="side-menu"]:visible').click(); // at the bottom on a desktop, at the top on a phone
  await expect(page.locator('#side-menu')).toBeVisible();
}

/** Opens the ⋯ menu of the room on screen (invite, clear chat history, leave), if it is not open already. */
export async function openRoomMenu(page: Page): Promise<void> {
  if (await page.locator('.room-menu:popover-open').count()) return;
  await page.locator('aside.side section.room.selected button.room-more').click();
  await expect(page.locator('.room-menu:popover-open')).toBeVisible();
}

/** Picks a theme from the ⚙ menu, then puts the menu away, so nothing of it is over what the test looks at next. */
export async function pickTheme(page: Page, value: string): Promise<void> {
  await openMenu(page);
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(value);
  await page.keyboard.press('Escape');
  await expect(page.locator('#side-menu')).toBeHidden();
}

/** Skips the current test when the app under test was built without the inspection hooks (a deployed copy). */
export async function needHooks(friend: Friend): Promise<void> {
  test.skip(!(await friend.hasHooks()), 'needs the inspection hooks: run against the e2e build, not a deployed copy');
}
