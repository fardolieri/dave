/**
 * The invariant watchdog (quality ticket 04): every INVARIANT_EVERY_MS while in a call, the call's facts go through the
 * rules in `core/invariants.ts`. A contradiction that held for its grace period is reported once per kind per call: a
 * console warning `[invariant] <kind> …` (problem reports carry it, and the e2e suite fails on it like on any other
 * warning), and with the opt-in a PostHog event `invariant_violation` with a compact snapshot: states and counters, the
 * gains as expected and as set. The event never pairs a friend's fingerprint with how loud I hear them; only the console
 * line, which stays in this tab unless a problem report is sent, names the fingerprint.
 */
import posthog from './posthog';
import { INVARIANT_EVERY_MS, breaches, createInvariantWatch, gainFor, type CallFacts, type InvariantKind, type Violation } from '../core/invariants';

export type InvariantReport = { kind: InvariantKind; heldMs: number; snapshot: Record<string, unknown> };

/**
 * The watchdog of one call, started on join and stopped on leave. `read` gives the call's facts; `describe` adds what the
 * console line wants to know of one peer beyond them (their fingerprint, restarts, …).
 */
export function createInvariantWatchdog(read: () => CallFacts | null, describe: (key: string) => Record<string, unknown>) {
  const watch = createInvariantWatch();
  /** What this call reported, for the inspection hooks. */
  let fired: InvariantReport[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  function report(v: Violation, facts: CallFacts): void {
    const p = facts.peers.find((q) => q.key === v.key);
    // The key stays in this tab. Gains as expected and as set, not the volumes behind them.
    const expected = (kind: 'voice' | 'share') => (p ? Math.round(gainFor(kind, { ...facts, ...p }) * 1000) / 1000 : null);
    const peer = p && {
      conn: p.conn, ice: p.ice, connection: p.connection, watching: p.watching, shareLive: p.shareLive, sharing: p.sharing,
      framesGrewMsAgo: p.framesGrewAt === null ? null : facts.at - p.framesGrewAt,
      voiceGain: p.voiceGain, voiceGainExpected: expected('voice'), shareGain: p.shareGain, shareGainExpected: expected('share'),
    };
    const snapshot = { peers: facts.peers.length, micTest: facts.micTest, peer };
    fired.push({ kind: v.kind, heldMs: v.heldMs, snapshot });
    console.warn(`[invariant] ${v.kind} held for ${Math.round(v.heldMs / 1000)} s`, JSON.stringify({ ...snapshot, peer: { ...describe(v.key), ...peer } }));
    posthog.capture('invariant_violation', { kind: v.kind, held_ms: v.heldMs, peers: facts.peers.length, snapshot: JSON.stringify(snapshot) });
  }
  // A hidden tab reads nothing: its timers are throttled, so what would set things right runs late too. The gap that
  // leaves makes the watch start over when the tab is back.
  const tick = () => {
    const now = document.visibilityState === 'hidden' ? null : read();
    if (!now) return;
    for (const v of watch.feed(now.at, breaches(now))) report(v, now);
  };
  return {
    /** A new call: nothing seen so far counts, and every kind may be reported again. */
    start(): void {
      clearInterval(timer);
      watch.reset();
      fired = [];
      timer = setInterval(tick, INVARIANT_EVERY_MS);
    },
    stop(): void { clearInterval(timer); timer = undefined; },
    violations: (): InvariantReport[] => fired.slice(),
  };
}
