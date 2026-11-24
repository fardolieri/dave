/**
 * PostHog analytics, opt-in per browser (ticket 32). Import `posthog` from here, never from posthog-js: until this
 * browser says yes, the SDK is not even loaded, so nothing reaches PostHog and nothing of it is stored. Events from
 * before the yes are dropped, not kept for later.
 *
 * The project key is a public client token (safe in the repo, see .env); without it, in production, every capture is
 * a no-op. Everything goes through this app's own Worker (`/diag`, worker/posthog.ts), never straight to posthog.com,
 * which tracker blockers drop even for a friend who said yes. This is a private friends room: session replay masks all
 * text and inputs, and no event ever carries message text or names.
 */
import type { PostHog } from 'posthog-js';
import { createSignal, untrack } from 'solid-js';
import { Outbox } from '../core/outbox';
import { local } from './storage';
import { build } from './version';

/**
 * A browser the e2e fixtures seeded with `dave.test = true`. Its events carry `is_test_account` and its person is marked
 * `$internal_or_test_user`, the property the project's "Internal / Test users" cohort keys on, so PostHog's test-account
 * filter drops it from insights.
 */
export const isTestAccount: boolean = local.read('test');

/**
 * On every event, so one can tell which copy of the app sent it: the live site ('live'), a pull request's preview
 * ('preview') or a test build ('e2e', 'local'). They all send to the same project. Registered with the SDK, and added by
 * hand to what goes without it.
 */
const buildProps = { build_commit: build.commit, build_target: build.target };

const key = import.meta.env['VITE_POSTHOG_KEY'] as string | undefined;
const host = import.meta.env['VITE_POSTHOG_HOST'] as string | undefined;
if ((!key || !host) && import.meta.env.DEV) console.warn('PostHog is not configured (VITE_POSTHOG_KEY / VITE_POSTHOG_HOST); events are dropped.');

/** This browser's answer to "Want to help me find bugs?"; null while it has not been asked. */
export type Consent = 'on' | 'off';
const [consent, setConsentSignal] = createSignal<Consent | null>(local.read('telemetry'));
export { consent };
export const telemetryOn = (): boolean => consent() === 'on';

type Props = Record<string, unknown>;
let sdk: PostHog | null = null;
let loading = false;
/** Captures between the yes and the SDK having loaded (a page load with consent given): sent once it is up. Bounded. */
let queue: Array<[string, Props | undefined]> = [];
const MAX_QUEUE = 100;
let person: { id: string; props: Props } | null = null;
const listeners = new Set<(on: boolean) => void>();

/**
 * The app's own events, handed to the SDK together at most every 30 s (core/outbox.ts): every request to PostHog is one
 * of the Worker's for the day. The SDK's own (a page view, an exception, the replay) and a problem report
 * (`captureOnce`) go as they come.
 *
 * Each keeps the time it happened, in HELD_AT, which `before_send` makes the event's timestamp. Not `capture`'s own
 * `timestamp` option: the SDK sends an event given any options at once, alone, outside its batch.
 */
const HELD_AT = 'held_at';
const outbox = new Outbox<[string, Props | undefined, number]>((held) => {
  if (!sdk || !untrack(telemetryOn)) return;
  for (const [event, props, at] of held) sdk.capture(event, { ...props, [HELD_AT]: at });
});
// Hidden, it may never be shown again (a phone closes a tab in the background without a pagehide): what is held goes to
// the SDK then, which sends it in its next 3 s. On pagehide this runs before the SDK's own listener, added later (at
// init), which sends what the SDK holds by beacon.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') outbox.flush(); });
addEventListener('pagehide', () => outbox.flush());

/** What the app adds to every event besides the build, as it changes (`posthog.register`): the theme on screen. */
const appProps: Props = {};

/** The super properties: on every event the SDK sends from here on. */
function register(ph: PostHog): void {
  ph.register({ ...buildProps, ...appProps, ...(isTestAccount ? { is_test_account: true } : {}) });
}

function start(): void {
  if (sdk) {
    sdk.opt_in_capturing();
    register(sdk); // the reset of the last no dropped them
    if (person) sdk.identify(person.id, person.props);
    sdk.startSessionRecording();
    return;
  }
  if (loading || !key || !host) return;
  loading = true;
  void import('posthog-js').then(({ default: ph }) => {
    loading = false;
    if (!telemetryOn()) return; // changed their mind while it loaded
    ph.init(key, {
      api_host: host,
      ui_host: 'https://eu.posthog.com', // links to the project from the SDK (the toolbar), which cannot be told from a relative host
      defaults: '2026-05-30',
      capture_exceptions: true,
      person_profiles: 'identified_only',
      // A no must leave nothing behind (forgetStoredData). Its own opt-in record goes too, after which it would count as
      // opted in again: without a record it is opted out, so the yes is given below explicitly, and opted out it keeps
      // its state in memory only. Saves are not debounced (the defaults' 250 ms), or one still pending lands after the removal.
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      persistence_save_debounce_ms: 0,
      before_send: (event) => {
        const at = event?.properties[HELD_AT];
        if (event && typeof at === 'number') {
          event.timestamp = new Date(at);
          delete event.properties[HELD_AT];
        }
        return event;
      },
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*', // chat, names, fingerprints: never in a recording
      },
    });
    // Registered before the opt-in, which captures the first $pageview there and then: it carries the build and the
    // theme like every later event (and `is_test_account`, so the test filter drops it).
    register(ph);
    if (!ph.has_opted_in_capturing()) ph.opt_in_capturing({ captureEventName: false });
    if (person) ph.identify(person.id, person.props);
    sdk = ph;
    for (const [event, props] of queue) ph.capture(event, props);
    queue = [];
  }, (e: unknown) => {
    // Blocked by a tracker blocker or a dropped line: nothing is kept, and the next yes (or page load) tries again.
    loading = false;
    queue = [];
    console.warn('PostHog did not load', e);
  });
}

function stop(): void {
  queue = [];
  outbox.drop();
  if (sdk) {
    sdk.stopSessionRecording();
    sdk.opt_out_capturing(); // before the reset, which drops that record again: opted out by default, it stays out
    sdk.reset();
  }
  forgetStoredData();
}

/**
 * Removes whatever posthog-js keeps in this browser: its local and session storage entries and its cookies. Run on
 * every load without consent too, for browsers that had PostHog before it became opt-in.
 */
function forgetStoredData(): void {
  const ours = (k: string) => k.startsWith('ph_') || k.startsWith('__ph_');
  for (const store of [localStorage, sessionStorage]) {
    try { for (const k of Object.keys(store)) if (ours(k)) store.removeItem(k); } catch { /* private mode etc. */ }
  }
  // posthog-js may set its cookie on a parent domain: try this host, then each parent, until it is gone. Never on an IP
  // or a one-label host, and stopping early keeps it off public suffixes (Firefox logs every rejected cookie).
  const host = location.hostname;
  const parts = /^[\d.]+$|^\[|^[^.]+$/.test(host) ? [] : host.split('.');
  const domains = [null, ...parts.slice(0, -1).map((_, i) => parts.slice(i).join('.'))];
  const has = (name: string) => document.cookie.split(';').some((c) => c.split('=')[0]!.trim() === name);
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]!.trim();
    if (!ours(name)) continue;
    for (const d of domains) {
      document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ''}`;
      if (!has(name)) break;
    }
  }
}

/**
 * Starts PostHog on this page load, for a browser that said yes. Called once the page is sure to stay (client/index.tsx,
 * after the opening update): a page that reloads by itself for a new version loads no SDK, so the reload cuts nothing
 * off. Firefox fails an import or a script a reload cuts off, and warns of each, from a page that is going anyway.
 */
export function startOnLoad(): void {
  if (telemetryOn()) start();
}

/** Records this browser's answer, starts or stops PostHog accordingly, and tells the rooms (the server keeps it per socket). */
export function setConsent(next: Consent): void {
  local.set('telemetry', next);
  setConsentSignal(next);
  if (next === 'on') start();
  else stop();
  for (const l of listeners) l(next === 'on');
}

/** Fires with every change of the answer. Returns the unsubscribe. */
export function onConsentChange(l: (on: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * One event sent because the friend asked for it (a problem report, a wish), with or without the opt-in, by hand to
 * PostHog's capture endpoint. Without the opt-in that is all: no SDK, no cookies, no person profile, no replay beside it.
 * With it, it carries the SDK's person and session, so it sits beside the replay as the SDK's own events do.
 *
 * Resolves to whether it went, once PostHog answered, so the friend is not told it did when it did not. Never through
 * the SDK, which says nothing of how a send went.
 *
 * It goes to `/e/`, not `/i/v0/e/`: EasyPrivacy, on by default in uBlock Origin and Brave, blocks `/i/v0/e/*` on every
 * site, our own origin too, and the wishes of two friends were lost to it (November 2026). The SDK's own events go there
 * too, as the project's remote config says. A bare `/e/` is too common a path for a list to block.
 */
export async function captureOnce(event: string, props: Props): Promise<boolean> {
  if (!key || !host) return false;
  const on = telemetryOn() ? sdk : null;
  // What led up to the report goes too, not up to 30 s after.
  if (on) outbox.flush();
  const body = {
    api_key: key,
    event,
    distinct_id: on ? on.get_distinct_id() : person?.id ?? 'anonymous',
    properties: {
      ...props, ...buildProps,
      ...(on ? { ...appProps, $session_id: on.get_session_id() } : { $process_person_profile: false }),
      ...(isTestAccount ? { is_test_account: true } : {}),
    },
    timestamp: new Date().toISOString(),
  };
  try {
    const res = await fetch(`${host}/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', keepalive: true });
    if (!res.ok) console.warn(`${event} not sent: ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn(`${event} not sent`, e);
    return false;
  }
}

/** The calls the app makes. They send nothing without the opt-in, as it is when they are made: effects and components call them too. */
const posthog = {
  capture(event: string, props?: Props): void {
    if (!untrack(telemetryOn) || !key || !host) return;
    if (sdk) outbox.add([event, { ...appProps, ...props }, Date.now()]); // the theme on screen then, not at the send
    else if (queue.length < MAX_QUEUE) queue.push([event, { ...appProps, ...props }]); // as they were when it happened, not when the SDK is up
  },
  /** Super properties of the app's own: on every event from now on, also after a later yes in this visit. */
  register(props: Props): void {
    Object.assign(appProps, props);
    if (untrack(telemetryOn) && sdk) sdk.register(props);
  },
  /** Remembered, so a later yes in this visit still ties events to the person. */
  identify(id: string, props: Props): void {
    person = { id, props };
    if (untrack(telemetryOn) && sdk) sdk.identify(id, props);
  },
};

if (!telemetryOn()) forgetStoredData();

export default posthog;
