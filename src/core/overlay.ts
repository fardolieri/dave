// The overlay: a room's list of friends, drawn for a picture-in-picture window (client/overlay.ts draws it onto a
// canvas played as a video). Runtime-neutral: what goes where, from plain data; the client measures text and paints.

/** One friend as the overlay shows them. */
export type OverlayRow = {
  key: string;
  name: string;
  /** Their picture (an emoji), else the first letter of their name. */
  face: string;
  pic: boolean;
  you: boolean;
  speaking: boolean;
  muted: boolean;
  /** In the call, their socket to the server gone: listed for the grace period, as the room lists them. */
  lost?: boolean;
};

/** What the overlay shows: the room's name, who is here and not in the call (me too, ready to join), and who is in it. */
export type OverlayModel = { room: string; here: OverlayRow[]; call: OverlayRow[] };

/** One thing to paint, in CSS pixels from the top left. Text is placed by its vertical middle. */
export type OverlayOp =
  | { kind: 'title'; x: number; y: number; text: string }
  | { kind: 'box'; x: number; y: number; w: number; h: number }
  | { kind: 'face'; cx: number; cy: number; r: number; text: string; pic: boolean; speaking: boolean }
  | { kind: 'name'; x: number; y: number; text: string }
  | { kind: 'tag'; right: number; y: number; text: string }
  | { kind: 'note'; x: number; y: number; text: string };

export type OverlayLayout = { width: number; height: number; ops: OverlayOp[] };

/** The overlay's width; its height follows the rows. Small, as a picture-in-picture window starts. */
export const OVERLAY_WIDTH = 280;
const PAD = 12, TITLE_H = 24, ROW_H = 34, FACE_R = 14, GAP = 8, BOX_PAD = 6, NOTE_H = 22;
export const NOBODY_IN_CALL = 'nobody in the call';
const LOST = 'connection lost';

/** Text measured in the font it is painted in: names are cut to fit with an ellipsis. */
export type Measure = (kind: 'title' | 'name' | 'tag', text: string) => number;

/** The longest start of `text` that fits in `width`, with "…" when cut. */
export function fitText(text: string, width: number, measure: (t: string) => number): string {
  if (measure(text) <= width) return text;
  const chars = [...text];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join('') + '…') <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : chars.slice(0, lo).join('').trimEnd() + '…';
}

/** Where everything goes: the title, the rows of who is here, then the call in a box of its own, or a line saying it is empty. */
export function layoutOverlay(m: OverlayModel, measure: Measure): OverlayLayout {
  const ops: OverlayOp[] = [];
  const inner = OVERLAY_WIDTH - 2 * PAD;
  let y = PAD;
  ops.push({ kind: 'title', x: PAD, y: y + TITLE_H / 2, text: fitText(m.room, inner, (t) => measure('title', t)) });
  y += TITLE_H + GAP / 2;
  const row = (r: OverlayRow, left: number, right: number) => {
    const cy = y + ROW_H / 2;
    ops.push({ kind: 'face', cx: left + FACE_R, cy, r: FACE_R, text: r.face, pic: r.pic, speaking: r.speaking });
    const nameX = left + 2 * FACE_R + GAP;
    const tag = r.lost ? LOST : r.muted ? 'muted' : null;
    const end = tag ? right - measure('tag', tag) - GAP : right;
    ops.push({ kind: 'name', x: nameX, y: cy, text: fitText(`${r.name}${r.you ? ' (you)' : ''}`, end - nameX, (t) => measure('name', t)) });
    if (tag) ops.push({ kind: 'tag', right, y: cy, text: tag });
    y += ROW_H;
  };
  for (const r of m.here) row(r, PAD, OVERLAY_WIDTH - PAD);
  if (m.call.length > 0) {
    if (m.here.length > 0) y += GAP;
    const top = y;
    ops.push({ kind: 'box', x: PAD, y: top, w: inner, h: m.call.length * ROW_H + 2 * BOX_PAD });
    y += BOX_PAD;
    for (const r of m.call) row(r, PAD + BOX_PAD, OVERLAY_WIDTH - PAD - BOX_PAD);
    y += BOX_PAD;
  } else {
    ops.push({ kind: 'note', x: PAD, y: y + NOTE_H / 2, text: NOBODY_IN_CALL });
    y += NOTE_H;
  }
  return { width: OVERLAY_WIDTH, height: Math.ceil(y + PAD), ops };
}

/** What the overlay says, top to bottom: for tests, which cannot look into a picture-in-picture window. */
export function overlayText(l: OverlayLayout): string[] {
  const out: string[] = [];
  for (const op of l.ops) {
    if (op.kind === 'title' || op.kind === 'note') out.push(op.text);
    else if (op.kind === 'face') out.push(`${op.text}${op.speaking ? ' (speaking)' : ''}`);
    else if (op.kind === 'name') out[out.length - 1] += ` ${op.text}`;
    else if (op.kind === 'tag') out[out.length - 1] += ` [${op.text}]`;
    else out.push('call:');
  }
  return out;
}
