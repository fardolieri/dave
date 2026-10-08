/**
 * The invariant watchdog (quality ticket 04): every INVARIANT_EVERY_MS while in a call, the call's facts go through the
 * rules in `core/invariants.ts`. A contradiction that held for its grace period is reported once per kind per call: a
 * console warning `[invariant] <kind> …` (problem reports carry it, and the e2e suite fails on it like on any other
 * warning), and with the opt-in a PostHog event `invariant_violation` with a compact snapshot: states, counters and gains,
 * a fingerprint, never a name or a text.
 */
import posthog from './posthog';
import { INVARIANT_EVERY_MS, breaches, createInvariantWatch, type CallFacts, type InvariantKind, type Violation } from '../core/invariants';

export type InvariantReport = { kind: InvariantKind; heldMs: number; snapshot: Record<string, unknown> };

/** Every violation this tab has reported, for the inspection hooks. */
const fired: InvariantReport[] = [];
export const invariantViolations = (): InvariantReport[] => fired.slice();

/**
 * Starts the watchdog. `read` gives the call's facts, or null while not in a call; `describe` adds what a report wants
 * to know of one peer beyond the facts (their fingerprint, restarts, …).
 */
export function createInvariantWatchdog(read: () => CallFacts | null, describe: (key: string) => Record<string, unknown>) {
  const watch = createInvariantWatch();
  function report(v: Violation, facts: CallFacts): void {
    const p = facts.peers.find((q) => q.key === v.key);
    // The key stays in this tab; the fingerprint `describe` adds is what reports carry.
    const peer = p && {
      conn: p.conn, ice: p.ice, connection: p.connection, watching: p.watching, shareLive: p.shareLive, sharing: p.sharing,
      framesGrewMsAgo: p.framesGrewAt === null ? null : facts.at - p.framesGrewAt,
      volume: p.volume, shareVolume: p.shareVolume, voiceGain: p.voiceGain, shareGain: p.shareGain,
    };
    const snapshot = { peers: facts.peers.length, master: facts.master, micTest: facts.micTest, peer: { ...describe(v.key), ...peer } };
    fired.push({ kind: v.kind, heldMs: v.heldMs, snapshot });
    console.warn(`[invariant] ${v.kind} held for ${Math.round(v.heldMs / 1000)} s`, JSON.stringify(snapshot));
    posthog.capture('invariant_violation', { kind: v.kind, held_ms: v.heldMs, peers: facts.peers.length, snapshot: JSON.stringify(snapshot) });
  }
  // A hidden tab reads nothing: its timers are throttled, so what would set things right runs late too. The gap that
  // leaves makes the watch start over when the tab is back.
  const timer = setInterval(() => {
    const now = document.visibilityState === 'hidden' ? null : read();
    if (!now) return;
    for (const v of watch.feed(now.at, breaches(now))) report(v, now);
  }, INVARIANT_EVERY_MS);
  return {
    /** A new call: every kind may be reported again. */
    reset(): void { watch.reset(); },
    stop(): void { clearInterval(timer); },
  };
}
