/**
 * PostHog analytics, opt-in per browser (ticket 32). Import `posthog` from here, never from posthog-js: until this
 * browser says yes, the SDK is not even loaded, so nothing reaches PostHog and nothing of it is stored. Events from
 * before the yes are dropped, not kept for later.
 *
 * The project key is a public client token (safe in the repo, see .env); without it, in production, every capture is
 * a no-op. This is a private friends room: session replay masks all text and inputs, and no event ever carries message
 * text or names.
 */
import type { PostHog } from 'posthog-js';
import { createSignal } from 'solid-js';
import { local } from './storage';

/**
 * A browser the e2e fixtures seeded with `dave.test = true`. Its events carry `is_test_account` and its person is marked
 * `$internal_or_test_user`, the property the project's "Internal / Test users" cohort keys on, so PostHog's test-account
 * filter drops it from insights.
 */
export const isTestAccount: boolean = local.get('test') === 'true';

const key = import.meta.env['VITE_POSTHOG_KEY'] as string | undefined;
const host = import.meta.env['VITE_POSTHOG_HOST'] as string | undefined;
if ((!key || !host) && import.meta.env.DEV) console.warn('PostHog is not configured (VITE_POSTHOG_KEY / VITE_POSTHOG_HOST); events are dropped.');

/** This browser's answer to "Want to help me find bugs?"; null while it has not been asked. */
export type Consent = 'on' | 'off';
const stored = local.get('telemetry');
const [consent, setConsentSignal] = createSignal<Consent | null>(stored === 'on' || stored === 'off' ? stored : null);
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

function start(): void {
  if (sdk) {
    sdk.opt_in_capturing();
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
      defaults: '2026-05-30',
      capture_exceptions: true,
      person_profiles: 'identified_only',
      // A no must leave nothing behind (forgetStoredData). Its own opt-in record goes too, after which it would count as
      // opted in again: without a record it is opted out, so the yes is given below explicitly, and opted out it keeps
      // its state in memory only. Saves are not debounced (the defaults' 250 ms), or one still pending lands after the removal.
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      persistence_save_debounce_ms: 0,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*', // chat, names, fingerprints: never in a recording
      },
    });
    if (!ph.has_opted_in_capturing()) ph.opt_in_capturing({ captureEventName: false });
    if (isTestAccount) ph.register({ is_test_account: true });
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
 * One event sent because the friend asked for it (a problem report), with or without the opt-in. Without it, it goes
 * straight to PostHog's capture endpoint: no SDK, no cookies, no person profile, no replay beside it.
 */
export function captureOnce(event: string, props: Props): void {
  if (telemetryOn() && sdk) { sdk.capture(event, props); return; }
  if (!key || !host) return;
  const body = {
    api_key: key,
    event,
    distinct_id: person?.id ?? 'anonymous',
    properties: { ...props, $process_person_profile: false, ...(isTestAccount ? { is_test_account: true } : {}) },
    timestamp: new Date().toISOString(),
  };
  void fetch(`${host}/i/v0/e/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', keepalive: true })
    .catch((e: unknown) => console.warn('problem report not sent', e));
}

/** The calls the app makes. Both do nothing without the opt-in. */
const posthog = {
  capture(event: string, props?: Props): void {
    if (!telemetryOn() || !key || !host) return;
    if (sdk) sdk.capture(event, props);
    else if (queue.length < MAX_QUEUE) queue.push([event, props]);
  },
  /** Remembered, so a later yes in this visit still ties events to the person. */
  identify(id: string, props: Props): void {
    person = { id, props };
    if (telemetryOn() && sdk) sdk.identify(id, props);
  },
};

if (telemetryOn()) start();
else forgetStoredData();

export default posthog;
