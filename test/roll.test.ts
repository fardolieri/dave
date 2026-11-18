import { describe, expect, it } from 'vitest';
import { ROLL_WAIT_MS, rollOf, rollsWaiting } from '../src/core/roll';

describe('rollOf', () => {
  it('tells a /yt from a /gif, and their searches', () => {
    expect(rollOf('/yt rick roll')).toEqual({ kind: 'video', search: 'rick roll' });
    expect(rollOf('/GIF  rick\n roll ')).toEqual({ kind: 'gif', search: 'rick roll' });
    for (const text of ['/gif', 'rick roll', '/gifs cats', 'a /gif cats']) expect(rollOf(text), text).toBeNull();
  });
});

describe('a /yt or /gif rolling', () => {
  const alice = { publicKey: 'alice' };
  const bob = { publicKey: 'bob' };
  const W = ROLL_WAIT_MS;
  const text = (id: string, from: { publicKey: string }, words: string, at = 1000) => ({ kind: 'text' as const, id, from, text: words, at });
  const card = (from: { publicKey: string }, at = 1500) => ({ kind: 'file' as const, from, file: { youtube: { id: 'dQw4w9WgXcQ' } }, at });
  const picture = (from: { publicKey: string }, at = 1500) => ({ kind: 'file' as const, from, file: {}, at });
  const gif = (from: { publicKey: string }, at = 1500) => ({ kind: 'file' as const, from, file: { gif: true }, at });
  const ended = (id: string) => ({ kind: 'system' as const, roll: id });
  const waiting = (lines: Parameters<typeof rollsWaiting>[0], me = 'bob', now = 2000) => [...rollsWaiting(lines, me, now).ids].sort();

  it('waits under its text until a YouTube card from its writer comes after it, each card answering the oldest', () => {
    expect(waiting([text('a1', alice, '/yt rick roll')])).toEqual(['a1']);
    expect(waiting([text('a1', alice, 'rick roll'), text('a2', alice, '/yt')])).toEqual([]);
    expect(waiting([text('a1', alice, '/yt rick roll'), card(alice)])).toEqual([]);
    expect(waiting([card(alice, 900), text('a1', alice, '/yt rick roll')]), 'a card before it').toEqual(['a1']);
    expect(waiting([text('a1', alice, '/yt rick roll'), card(bob), picture(alice)]), 'another\'s card, or a picture').toEqual(['a1']);
    expect(waiting([text('a1', alice, '/yt cats'), text('a2', alice, '/yt dogs'), text('b1', bob, '/yt birds'), card(alice)])).toEqual(['a2', 'b1']);
  });

  it('stops at the latest ROLL_WAIT_MS after it was written; a card answers none whose time was up when it came', () => {
    const two = [text('a1', alice, '/yt cats', 1000), text('a2', alice, '/yt dogs', 3000)];
    expect(rollsWaiting(two, 'bob', 2000).next).toBe(1000 + W);
    expect(waiting(two, 'bob', 1000 + W)).toEqual(['a2']);
    expect(rollsWaiting([text('a1', alice, '/yt cats', 1000)], 'bob', 1000 + W)).toEqual({ ids: new Set(), next: null });
    // A card that came for the first in time stays its answer once the first's time is up.
    const answered = [text('a1', alice, '/yt cats', 0), text('k1', { publicKey: 'carol' }, '/yt zzzz', 500), text('a2', alice, '/yt dogs', 2000), card(alice, 4000)];
    expect(waiting(answered, 'bob', 19_000)).toEqual(['a2', 'k1']);
    expect(waiting(answered, 'bob', 500 + W + 50)).toEqual(['a2']);
    // One whose time was up when a card came answers it not: the card is the next one's.
    expect(waiting([...two, card(alice, 1000 + W + 1)], 'bob', 1000 + W + 2)).toEqual([]);
  });

  it('in its writer\'s own log, stops when her app says that text sent none, wherever that is said', () => {
    expect(waiting([text('bob:x1', bob, '/yt zzzz'), text('a1', alice, '/yt cats'), ended('x1')])).toEqual(['a1']);
    expect(waiting([ended('x1'), text('pending:x1', bob, '/yt zzzz')]), 'mine, not back from the Room, drawn after it').toEqual([]);
    expect(waiting([text('pairkey:x1', bob, '/yt zzzz'), ended('x1')]), 'in a conversation, under my key in our room of two').toEqual([]);
    expect(waiting([text('alice:x1', alice, '/yt cats'), ended('x1')], 'bob'), 'another\'s text of the same id').toEqual(['alice:x1']);
    // A roll that found none, then another a while later: its card is its own, not the first's.
    const retry = [text('bob:x1', bob, '/yt zzzz', 0), ended('x1'), text('bob:x2', bob, '/yt lofi', 20_000), card(bob, 22_000)];
    expect(waiting(retry, 'bob', 22_500)).toEqual([]);
    expect(waiting(retry.slice(0, 3), 'bob', 21_000)).toEqual(['bob:x2']);
  });

  it('a /gif waits for a GIF from its writer as a /yt for a card, each answering only the rolls of its own kind', () => {
    expect(waiting([text('a1', alice, '/gif rick roll')])).toEqual(['a1']);
    expect(waiting([text('a1', alice, '/gif rick roll'), gif(alice)])).toEqual([]);
    expect(waiting([text('a1', alice, '/gif rick roll'), card(alice), picture(alice), gif(bob)]), 'a card, a picture, another\'s GIF').toEqual(['a1']);
    expect(waiting([text('a1', alice, '/yt cats'), text('a2', alice, '/gif cats'), gif(alice)])).toEqual(['a1']);
    expect(waiting([text('a1', alice, '/gif cats'), text('a2', alice, '/yt cats'), card(alice)])).toEqual(['a1']);
    expect(waiting([text('bob:x1', bob, '/gif zzzz'), ended('x1')]), 'mine, that sent none').toEqual([]);
    expect(rollsWaiting([text('a1', alice, '/gif cats', 1000)], 'bob', 1000 + W)).toEqual({ ids: new Set(), next: null });
  });
});
