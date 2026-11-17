// The app's own PostHog events, held and sent together (client/posthog.ts). Every request to PostHog goes through our
// Worker (`/diag`) and is one of the Worker's 100,000 a day on the Workers Free plan, the previews' and the live site's
// together. The SDK sends what it has every 3 s and lets no one ask for more than 5, so a friend in a call sent a request
// for nearly every event: `voice_send` and each friend's `voice_quality` every 30 s, on clocks of their own. On
// 2026-11-17 that was about 3,100 requests for 4,800 events, most of the live site's own use of the Worker. Held for
// OUTBOX_EVERY_MS, the same events go in about half as many. Runtime-neutral.

/** How long the first event of a batch waits for the others. */
export const OUTBOX_EVERY_MS = 30_000;
/**
 * A batch this large goes at once, so a burst is not held in memory, nor sent as one oversized request. Half the SDK's
 * own burst allowance (10 events a second, 100 at once): a full batch handed over with other events about is not cut.
 */
export const OUTBOX_MAX = 50;

export class Outbox<T> {
  private held: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: (items: T[]) => void, private readonly every = OUTBOX_EVERY_MS, private readonly max = OUTBOX_MAX) {}

  /** Holds the item; the first of a batch starts the wait, so none waits longer than `every`. */
  add(item: T): void {
    this.held.push(item);
    if (this.held.length >= this.max) this.flush();
    else this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, this.every);
  }

  /** Sends what is held now (the page going away), or nothing when nothing is. */
  flush(): void {
    this.stop();
    if (!this.held.length) return;
    const items = this.held;
    this.held = [];
    this.send(items);
  }

  /** Forgets what is held, unsent. */
  drop(): void {
    this.stop();
    this.held = [];
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
