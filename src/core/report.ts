/**
 * The shape of a problem report as PostHog sees it (ticket 12, follow-up 15). Runtime-neutral: no DOM,
 * no SDK, so it is unit-tested. The snapshot stays attached as one JSON string; what one filters or
 * reads at a glance is lifted into top-level event properties here.
 */

/** The part of the client's `Report` this module reads. Structural, so the client type satisfies it without importing browser types here. */
export type ReportShape = {
  page: { online: boolean; visible: boolean; viewport: string };
  server: { status: string; visitors: number; participants: number; me: string | null };
  call: {
    inCall: boolean; muted: boolean; sharing: unknown; outgoing: { viewers: number } | null; ice: { turn: boolean };
    peers: Array<{ view: { conn: string; watching: boolean; shareLive: boolean } }>;
  };
  videoElements: Array<{ hidden: boolean; width: number; frames: number | null }>;
  log: Array<{ level: 'warn' | 'error' }>;
};

/** What the friend says is broken. One tag so reports group without reading each description. */
export const CATEGORIES = {
  connection: 'Connecting or staying connected',
  audio: 'Voice: hearing or being heard',
  share: 'Screen share: black, frozen, blurry',
  text: 'Text chat',
  other: 'Something else',
} as const;
export type Category = keyof typeof CATEGORIES;

/** How badly it hurts. Two steps are enough for a friends room; finer scales are never filled in consistently. */
export const SEVERITIES = {
  annoying: 'Annoying, I can work around it',
  blocking: 'Blocking, I cannot use it',
} as const;
export type Severity = keyof typeof SEVERITIES;

export type ReportForm = { text: string; category: Category; severity: Severity };

export const isCategory = (v: string): v is Category => Object.hasOwn(CATEGORIES, v);
export const isSeverity = (v: string): v is Severity => Object.hasOwn(SEVERITIES, v);

/** A share tile that is shown but has no size or has never decoded a frame. */
export const isBlackTile = (v: ReportShape['videoElements'][number]): boolean => !v.hidden && (v.width === 0 || v.frames === 0);

/**
 * Event properties for `bug_report`. Flat, primitive, and named so an insight can filter or break
 * down on them without parsing `report`. Never names or message texts; the reporter is a fingerprint.
 */
export function reportProperties(form: ReportForm, report: ReportShape): Record<string, string | number | boolean | null> {
  const peers = report.call.peers;
  return {
    text: form.text.trim(),
    category: form.category,
    severity: form.severity,
    report: JSON.stringify(report),
    reporter: report.server.me,
    // The page
    online: report.page.online,
    visible: report.page.visible,
    viewport: report.page.viewport,
    // The room as the server tells it
    server_status: report.server.status,
    participants: report.server.participants,
    visitors: report.server.visitors,
    // The call from this tab's point of view
    in_call: report.call.inCall,
    muted: report.call.muted,
    sharing: report.call.sharing !== null,
    share_viewers: report.call.outgoing?.viewers ?? 0,
    turn_configured: report.call.ice.turn,
    peers: peers.length,
    peers_direct: peers.filter((p) => p.view.conn === 'direct').length,
    peers_relayed: peers.filter((p) => p.view.conn === 'relayed').length,
    peers_troubled: peers.filter((p) => p.view.conn === 'connecting' || p.view.conn === 'reconnecting' || p.view.conn === 'unreachable').length,
    watching_count: peers.filter((p) => p.view.watching).length,
    shares_live: peers.filter((p) => p.view.shareLive).length,
    black_tiles: report.videoElements.filter(isBlackTile).length,
    // Recent console noise
    warnings: report.log.filter((e) => e.level === 'warn').length,
    errors: report.log.filter((e) => e.level === 'error').length,
  };
}

/** Clipboard text for browsers that block PostHog: the human part first, the snapshot below. */
export const formatReport = (form: ReportForm, report: ReportShape): string =>
  `${form.text.trim()}\n\nCategory: ${CATEGORIES[form.category]}\nSeverity: ${SEVERITIES[form.severity]}\n\n--- technical snapshot ---\n${JSON.stringify(report, null, 1)}`;
