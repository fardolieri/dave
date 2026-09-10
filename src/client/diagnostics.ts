/**
 * Problem reports (ticket 12). A friend describes what went wrong; the report carries a technical
 * snapshot of this tab: connection states and media counters per peer, the share tiles' video
 * elements, recent console warnings. Never message texts or names, only fingerprints. It goes to
 * PostHog as one event, next to the masked session replay of the same tab, and can be copied as
 * text for browsers that block PostHog. The event's shape (category, severity, flat fields) lives in
 * `core/report.ts`, which has no DOM or SDK dependency and is unit-tested.
 */
import posthog from './posthog';
import { recentLog } from './log';
import type { CallDiagnostics } from './call';
import { reportProperties, type ReportForm } from '../core/report';

export { formatReport } from '../core/report';

export type Report = {
  at: string;
  page: { url: string; visible: boolean; online: boolean; viewport: string; screen: string; language: string; userAgent: string };
  server: { status: string; visitors: number; participants: number; me: string | null };
  call: CallDiagnostics;
  videoElements: Array<{ readyState: number; width: number; height: number; paused: boolean; ended: boolean; error: number | null; hidden: boolean; frames: number | null; dropped: number | null }>;
  log: ReturnType<typeof recentLog>;
};

export type ReportSources = {
  status: () => string;
  people: () => Array<{ role: string; publicKey: string; fingerprint: string }>;
  me: () => string | null;
  call: () => Promise<CallDiagnostics>;
};

export async function collectReport(src: ReportSources): Promise<Report> {
  const people = src.people();
  const me = src.me();
  return {
    at: new Date().toISOString(),
    page: {
      url: location.pathname, visible: document.visibilityState === 'visible', online: navigator.onLine,
      viewport: `${innerWidth}x${innerHeight}`, screen: `${screen.width}x${screen.height}`, language: navigator.language, userAgent: navigator.userAgent,
    },
    server: {
      status: src.status(), visitors: people.filter((p) => p.role === 'visitor').length, participants: people.filter((p) => p.role === 'participant').length,
      me: people.find((p) => p.publicKey === me)?.fingerprint ?? null,
    },
    call: await src.call(),
    videoElements: videoElementStates(),
    log: recentLog(),
  };
}

/** What the share tiles' video elements say about themselves: the difference between "no frames arrive" and "frames arrive but do not show". */
export function videoElementStates(): Report['videoElements'] {
  return [...document.querySelectorAll<HTMLVideoElement>('.share video')].map((v) => {
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    return { readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, paused: v.paused, ended: v.ended, error: v.error?.code ?? null, hidden: v.hidden, frames: q?.totalVideoFrames ?? null, dropped: q?.droppedVideoFrames ?? null };
  });
}

/** One event: the friend's words and tags as properties, the snapshot as JSON, and the flat fields `reportProperties` lifts out of it. */
export function sendReport(form: ReportForm, report: Report): void {
  posthog.capture('bug_report', reportProperties(form, report));
}
