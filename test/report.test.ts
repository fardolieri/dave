import { describe, expect, it } from 'vitest';
import { CATEGORIES, SEVERITIES, formatReport, isBlackTile, isCategory, isSeverity, reportProperties, type ReportShape } from '../src/core/report';

type Peer = ReportShape['call']['peers'][number];
const peer = (view: Partial<Peer['view']>): Peer => ({ view: { conn: 'direct', watching: false, shareLive: false, ...view } });

const report: ReportShape = {
  page: { visible: true, online: false, viewport: '1280x720' },
  server: { status: 'connected', visitors: 1, participants: 3, me: 'me00-me00' },
  call: {
    inCall: true, muted: true, sharing: { width: 1920 }, outgoing: { viewers: 2 }, ice: { turn: true },
    peers: [peer({ conn: 'direct', watching: true, shareLive: true }), peer({ conn: 'relayed', watching: true, shareLive: false }), peer({ conn: 'reconnecting' })],
  },
  videoElements: [
    { hidden: false, width: 1280, frames: 300, paused: false },
    { hidden: false, width: 0, frames: 0, paused: false },
    { hidden: true, width: 0, frames: 0, paused: true },
    { hidden: false, width: 1280, frames: 300, paused: true }, // frames arrive, the element never started: black
  ],
  log: [{ level: 'warn' }, { level: 'error' }, { level: 'error' }],
};

describe('reportProperties', () => {
  const props = reportProperties({ text: '  the share is black \n', category: 'share', severity: 'blocking' }, report);

  it('carries the tags, the trimmed words and the reporter fingerprint', () => {
    expect(props['category']).toBe('share');
    expect(props['severity']).toBe('blocking');
    expect(props['text']).toBe('the share is black');
    expect(props['reporter']).toBe('me00-me00');
  });
  it('keeps the whole snapshot as one JSON string', () => {
    expect(JSON.parse(props['report'] as string)).toEqual(report);
  });
  it('lifts the room, page and call state to flat fields', () => {
    expect(props).toMatchObject({
      online: false, visible: true, viewport: '1280x720',
      server_status: 'connected', participants: 3, visitors: 1,
      in_call: true, muted: true, sharing: true, share_viewers: 2, turn_configured: true,
      peers: 3, peers_direct: 1, peers_relayed: 1, peers_troubled: 1, watching_count: 2, shares_live: 1,
      black_tiles: 2, warnings: 1, errors: 2,
    });
  });
  it('is flat: every value is a primitive, so each is filterable in PostHog', () => {
    for (const v of Object.values(props)) expect(['string', 'number', 'boolean']).toContain(v === null ? 'string' : typeof v);
  });
  it('never carries a name or message text field', () => {
    expect(Object.keys(props)).not.toContain('name');
    expect(props['report']).not.toContain('"name"');
  });
  it('counts nothing when the tab is not in a call', () => {
    const idle = reportProperties({ text: 'x', category: 'other', severity: 'annoying' }, { ...report, call: { ...report.call, inCall: false, sharing: null, outgoing: null, peers: [] }, videoElements: [], log: [] });
    expect(idle).toMatchObject({ in_call: false, sharing: false, share_viewers: 0, peers: 0, watching_count: 0, black_tiles: 0, warnings: 0, errors: 0 });
  });
});

describe('isBlackTile', () => {
  it('flags a shown tile with no size, no decoded frame, or a paused element, not a hidden one', () => {
    expect(report.videoElements.map(isBlackTile)).toEqual([false, true, false, true]);
  });
});

describe('categories and severities', () => {
  it('accept exactly their keys', () => {
    for (const k of Object.keys(CATEGORIES)) expect(isCategory(k)).toBe(true);
    for (const k of Object.keys(SEVERITIES)) expect(isSeverity(k)).toBe(true);
    expect(isCategory('video')).toBe(false);
    expect(isSeverity('critical')).toBe(false);
    expect(isCategory('constructor')).toBe(false);
  });
});

describe('formatReport', () => {
  it('puts the words and tags before the snapshot', () => {
    const text = formatReport({ text: 'no sound', category: 'audio', severity: 'blocking' }, report);
    expect(text.startsWith('no sound\n\nCategory: Voice: hearing or being heard\nSeverity: Blocking, I cannot use it\n\n--- technical snapshot ---\n')).toBe(true);
    expect(text).toContain('"participants": 3');
  });
});
