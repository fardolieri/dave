import { describe, expect, it } from 'vitest';
import {
  AUTO_PULL_BYTES, MAX_FILE_BYTES, MAX_PREVIEW_LENGTH, formatSize, inlineKind, keepWithin, parseFileIndex, parseFileMeta, parsePullFrame, pullsByItself,
  type FileMeta,
} from '../src/core/attachment';
import { MAX_SEALED_FILE_LENGTH, parseClientMessage, type Person } from '../src/core/protocol';
import { onMessage, type RoomContext, type SocketState } from '../src/core/room';
import { LINK_ICE_TTL_SECONDS } from '../src/core/mesh';
import { newBucket } from '../src/core/ratelimit';

const HASH = 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg';
const photo: FileMeta = { name: 'cat.jpg', type: 'image/jpeg', size: 2_000_000, hash: HASH, preview: 'data:image/webp;base64,UklGRg==', width: 4032, height: 3024 };

describe('attachments (ADR 0006)', () => {
  it('takes a file description as a friend wrote it, and nothing off', () => {
    expect(parseFileMeta(photo)).toEqual(photo);
    expect(parseFileMeta({ name: 'notes.txt', type: '', size: 0, hash: HASH })).toEqual({ name: 'notes.txt', type: '', size: 0, hash: HASH });
    for (const off of [
      { name: '' }, { name: '  ' }, { name: 'x'.repeat(256) }, { type: 7 }, { size: -1 }, { size: 1.5 }, { size: MAX_FILE_BYTES + 1 },
      { hash: 'short' }, { hash: HASH + 'x' }, { preview: 'https://example.com/cat.png' }, { preview: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { preview: `data:image/webp;base64,${'A'.repeat(MAX_PREVIEW_LENGTH)}` }, { width: 10, height: undefined }, { width: 0, height: 10 },
    ]) expect(parseFileMeta({ ...photo, ...off }), JSON.stringify(off)).toBeNull();
    expect(parseFileMeta(null)).toBeNull();
    expect(parseFileMeta('cat.jpg')).toBeNull();
  });

  it('shows only pictures and videos of known types inline, never SVG or HTML', () => {
    expect(inlineKind('image/jpeg')).toBe('image');
    expect(inlineKind('image/GIF')).toBe('image');
    expect(inlineKind('video/mp4')).toBe('video');
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/pdf', '']) expect(inlineKind(type), type).toBeNull();
  });

  it('pulls pictures and videos up to 16 MB by themselves, anything else on a click', () => {
    expect(pullsByItself(photo)).toBe(true);
    expect(pullsByItself({ ...photo, size: AUTO_PULL_BYTES + 1 })).toBe(false);
    expect(pullsByItself({ ...photo, type: 'application/zip', size: 10 })).toBe(false);
  });

  it('keeps files within the budget, the oldest going first', () => {
    const f = (hash: string, size: number, at = 0) => ({ hash: hash.padEnd(43, 'a'), size, at });
    const index = [f('a', 40), f('b', 30), f('c', 20)];
    expect(keepWithin(index, f('d', 10), 100)).toEqual({ index: [...index, f('d', 10)], drop: [], kept: true });
    expect(keepWithin(index, f('d', 50), 100)).toEqual({ index: [f('b', 30), f('c', 20), f('d', 50)], drop: [f('a', 0).hash], kept: true });
    expect(keepWithin(index, f('d', 60), 100)).toEqual({ index: [f('c', 20), f('d', 60)], drop: [f('a', 0).hash, f('b', 0).hash], kept: true });
    // One kept already only moves to the newest end.
    expect(keepWithin(index, f('a', 40, 9), 100)).toEqual({ index: [f('b', 30), f('c', 20), f('a', 40, 9)], drop: [], kept: true });
    // One larger than the whole budget is not kept, and costs nothing else.
    expect(keepWithin(index, f('d', 101), 100)).toEqual({ index, drop: [], kept: false });
  });

  it('reads the index of kept files, dropping what is off', () => {
    expect(parseFileIndex(undefined)).toEqual([]);
    expect(parseFileIndex([{ hash: HASH, size: 3, at: 1 }, { hash: 'x', size: 3, at: 1 }, null, { hash: HASH, size: -1, at: 1 }])).toEqual([{ hash: HASH, size: 3, at: 1 }]);
  });

  it('reads the frames of a pull', () => {
    expect(parsePullFrame(JSON.stringify({ t: 'get', hash: HASH, offset: 0 }))).toEqual({ t: 'get', hash: HASH, offset: 0 });
    expect(parsePullFrame(JSON.stringify({ t: 'have', size: 12 }))).toEqual({ t: 'have', size: 12 });
    expect(parsePullFrame(JSON.stringify({ t: 'none' }))).toEqual({ t: 'none' });
    for (const bad of ['{', '"get"', JSON.stringify({ t: 'get', hash: 'x', offset: 0 }), JSON.stringify({ t: 'get', hash: HASH, offset: -1 }), JSON.stringify({ t: 'have', size: MAX_FILE_BYTES + 1 })]) {
      expect(parsePullFrame(bad), bad).toBeNull();
    }
    expect(parsePullFrame(new ArrayBuffer(4))).toBeNull();
  });

  it('says sizes as the chat shows them', () => {
    expect([formatSize(900), formatSize(2048), formatSize(2.44 * 1024 * 1024), formatSize(23 * 1024 * 1024)]).toEqual(['900 B', '2 KB', '2.4 MB', '23 MB']);
  });
});

describe('files and file links on the wire (ADR 0006)', () => {
  it('parses a file announcement, capped at what the longest one seals to', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'file', sealed: 'c2Vh', id: 'a1b2' }))).toEqual({ t: 'file', sealed: 'c2Vh', id: 'a1b2' });
    expect(parseClientMessage(JSON.stringify({ t: 'file', sealed: 'A'.repeat(MAX_SEALED_FILE_LENGTH + 1), id: 'a1b2' }))).toEqual({ t: 'invalid', reason: 'file description too long', ref: 'file' });
    expect(parseClientMessage(JSON.stringify({ t: 'file', sealed: 'not base64!', id: 'a1b2' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'file' });
  });

  it('parses link signaling and the ask for its ICE servers', () => {
    const data = { link: 'abc', description: { type: 'offer', sdp: 'v=0' }, sig: 'c2ln' };
    expect(parseClientMessage(JSON.stringify({ t: 'link', to: 'k-bob', data }))).toEqual({ t: 'link', to: 'k-bob', data });
    expect(parseClientMessage(JSON.stringify({ t: 'link', to: 'k-bob', data: { link: 'abc', candidates: [{}] } }))).toEqual({ t: 'link', to: 'k-bob', data: { link: 'abc', candidates: [{}] } });
    for (const d of [{ description: {} }, { link: 'no spaces', description: {} }, { link: 'abc' }, { link: 'abc', candidates: 'x' }]) {
      expect(parseClientMessage(JSON.stringify({ t: 'link', to: 'k-bob', data: d })), JSON.stringify(d)).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'link' });
    }
    expect(parseClientMessage(JSON.stringify({ t: 'linkice', id: 3 }))).toEqual({ t: 'linkice', id: 3 });
    expect(parseClientMessage(JSON.stringify({ t: 'linkice' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'linkice' });
  });
});

describe('the Room and files (ADR 0006)', () => {
  const person = (publicKey: string, role: Person['role'] = 'visitor'): Person => ({ publicKey, fingerprint: 'f', name: publicKey, role, joinSeq: role === 'participant' ? 1 : null, sharing: false, muted: false });
  const alice: SocketState = { stage: 'attached', person: person('k-alice'), bucket: newBucket(0), attachedAt: 0 };
  const ttls: Array<number | undefined> = [];
  const ctx = (others: Person[]): RoomContext => ({ authKey: 'a', now: 5, others, mintIce: async (ttl) => { ttls.push(ttl); return { iceServers: [{ urls: 'turn:x' }], turnUser: 'u1' }; } });

  it('passes an announcement on to everyone, tagged like a text, without reading it', async () => {
    const out = await onMessage(alice, JSON.stringify({ t: 'file', sealed: 'c2Vh', id: 'a1b2' }), ctx([]));
    expect(out.broadcast).toEqual([{ t: 'file', from: { publicKey: 'k-alice', fingerprint: 'f', name: 'k-alice' }, sealed: 'c2Vh', at: 5, id: 'a1b2' }]);
  });

  it('relays link signaling between visitors, and to nobody absent or to oneself', async () => {
    const frame = (to: string) => JSON.stringify({ t: 'link', to, data: { link: 'abc', candidates: [] } });
    expect((await onMessage(alice, frame('k-bob'), ctx([person('k-bob')]))).relay).toEqual({ to: 'k-bob', message: { t: 'link', from: 'k-alice', data: { link: 'abc', candidates: [] } } });
    expect((await onMessage(alice, frame('k-carol'), ctx([person('k-bob')]))).replies).toEqual([{ t: 'error', reason: 'that friend is not here', ref: 'link' }]);
    expect((await onMessage(alice, frame('k-alice'), ctx([person('k-bob')]))).replies).toEqual([{ t: 'error', reason: 'that friend is not here', ref: 'link' }]);
  });

  it('mints one-hour ICE servers for a visitor\'s link, and keeps no TURN user for it', async () => {
    const out = await onMessage(alice, JSON.stringify({ t: 'linkice', id: 4 }), ctx([]));
    expect(out.state).toMatchObject({ stage: 'attached' });
    expect((out.state as Extract<SocketState, { stage: 'attached' }>).turnUsers).toBeUndefined();
    expect(await out.after!()).toEqual({ replies: [{ t: 'linkice', iceServers: [{ urls: 'turn:x' }], issuedAt: 5, id: 4 }], minted: null });
    expect(ttls.at(-1)).toBe(LINK_ICE_TTL_SECONDS);
    // Asked again within a minute: refused, so a loop or a flood mints no TURN users.
    expect((await onMessage(out.state, JSON.stringify({ t: 'linkice', id: 5 }), ctx([]))).replies).toEqual([{ t: 'error', reason: 'asked too soon', ref: 'linkice' }]);
  });

  it('rate limits link signaling apart from the call\'s, and says which was dropped', async () => {
    let state: SocketState = alice;
    let last;
    for (let i = 0; i < 401; i++) {
      last = await onMessage(state, JSON.stringify({ t: 'link', to: 'k-bob', data: { link: 'abc', candidates: [] } }), ctx([person('k-bob')]));
      state = last.state;
    }
    expect(last!.replies).toEqual([{ t: 'error', reason: 'rate limited', ref: 'link' }]);
    const signal = await onMessage(state, JSON.stringify({ t: 'signal', to: 'k-bob', data: { candidates: [] } }), ctx([person('k-bob', 'participant')]));
    expect(signal.replies).toEqual([{ t: 'error', reason: 'not in the call', ref: 'signal' }]); // past the limit, on to the next check
  });
});
