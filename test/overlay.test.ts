import { describe, expect, it } from 'vitest';
import { fitText, layoutOverlay, NOBODY_IN_CALL, OVERLAY_WIDTH, overlayText, type OverlayRow } from '../src/core/overlay';

// Every character 7 px wide: enough to tell what fits from what is cut
const measure = (_kind: string, text: string) => [...text].length * 7;
const row = (name: string, more: Partial<OverlayRow> = {}): OverlayRow => ({ key: name, name, face: name[0]!, pic: false, you: false, speaking: false, muted: false, ...more });

describe('layoutOverlay', () => {
  it('lists who is here, then says the call is empty', () => {
    const l = layoutOverlay({ room: 'Friends', here: [row('Bob', { face: '🦎', pic: true }), row('Alice', { you: true })], call: [] }, measure);
    expect(overlayText(l)).toEqual(['Friends', '🦎 Bob', 'A Alice (you)', NOBODY_IN_CALL]);
    expect(l.ops.some((op) => op.kind === 'box')).toBe(false);
    expect(l.width).toBe(OVERLAY_WIDTH);
  });

  it('puts the call in a box of its own below who is here, with who speaks and who is muted', () => {
    const l = layoutOverlay({ room: 'Friends', here: [row('Carol')], call: [row('Alice', { you: true, speaking: true }), row('Bob', { muted: true })] }, measure);
    expect(overlayText(l)).toEqual(['Friends', 'C Carol', 'call:', 'A (speaking) Alice (you)', 'B Bob [muted]']);
    const box = l.ops.find((op) => op.kind === 'box')!;
    const faces = l.ops.filter((op) => op.kind === 'face');
    // The call's rows inside its box, who is here above it
    for (const f of faces.slice(1)) if (f.kind === 'face' && box.kind === 'box') expect(f.cy - f.r).toBeGreaterThanOrEqual(box.y);
    if (faces[0]!.kind === 'face' && box.kind === 'box') expect(faces[0]!.cy + faces[0]!.r).toBeLessThanOrEqual(box.y);
    if (box.kind === 'box') expect(l.height).toBeGreaterThan(box.y + box.h);
  });

  it('keeps a friend whose connection to the server is gone in the call, said so, as the room does', () => {
    const l = layoutOverlay({ room: 'R', here: [], call: [row('Bob', { lost: true, muted: true })] }, measure);
    expect(overlayText(l)).toEqual(['R', 'call:', 'B Bob [connection lost]']);
  });

  it('grows with the rows, so the window has room for everyone', () => {
    const one = layoutOverlay({ room: 'R', here: [row('A')], call: [] }, measure);
    const three = layoutOverlay({ room: 'R', here: [row('A'), row('B')], call: [row('C')] }, measure);
    expect(three.height).toBeGreaterThan(one.height);
  });

  it('cuts a long name to the width, leaving room for "muted"', () => {
    const long = 'Bartholomew the very talkative friend';
    const l = layoutOverlay({ room: 'R', here: [], call: [row(long, { muted: true })] }, measure);
    const name = l.ops.find((op) => op.kind === 'name')!;
    const tag = l.ops.find((op) => op.kind === 'tag')!;
    if (name.kind !== 'name' || tag.kind !== 'tag') throw new Error('no name or tag');
    expect(name.text.endsWith('…')).toBe(true);
    expect(name.x + measure('name', name.text)).toBeLessThanOrEqual(tag.right - measure('tag', 'muted'));
  });
});

describe('fitText', () => {
  const m = (t: string) => [...t].length * 10;
  it('leaves what fits alone and cuts the rest with an ellipsis', () => {
    expect(fitText('Alice', 50, m)).toBe('Alice');
    expect(fitText('Alice B', 50, m)).toBe('Alic…');
    expect(fitText('Alice', 5, m)).toBe('…');
  });
  it('never cuts an emoji in half', () => {
    expect(fitText('🦎🦎🦎', 25, m)).toBe('🦎…');
  });
});
