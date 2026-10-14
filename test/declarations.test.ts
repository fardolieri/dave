import { describe, expect, it } from 'vitest';
import {
  afterJoin, afterWelcome, carried, declare, declared, forgetEnded, forgetWatch, inCallOnly, joinDeclares, leaveCall,
} from '../src/core/declarations';
import type { Person } from '../src/core/protocol';

const person = (publicKey: string, over: Partial<Person> = {}): Person => ({
  publicKey, fingerprint: 'ABC123', name: publicKey, role: 'participant', joinSeq: 1, sharing: false, muted: false, ...over,
});

describe('declarations (quality ticket 10)', () => {
  it('the auth carries the latest name, picture and opt-in', () => {
    const d = declared('Alice', '😀', false);
    expect(carried(d)).toEqual({ name: 'Alice', picture: '😀', telemetry: false });
    declare(d, { t: 'name', name: 'Alicia' });
    declare(d, { t: 'picture', picture: null });
    declare(d, { t: 'telemetry', on: true });
    expect(carried(d)).toEqual({ name: 'Alicia', picture: null, telemetry: true });
  });

  it('after the welcome, only what changed since the auth went out is said again', () => {
    const d = declared('Alice', '😀', false);
    const auth = carried(d);
    expect(afterWelcome(d, auth)).toEqual([]);
    declare(d, { t: 'name', name: 'Alicia' }); // renamed during the handshake (review on 10-10)
    expect(afterWelcome(d, auth)).toEqual([{ t: 'name', name: 'Alicia' }]);
    declare(d, { t: 'picture', picture: null });
    declare(d, { t: 'telemetry', on: true });
    expect(afterWelcome(d, auth)).toEqual([{ t: 'name', name: 'Alicia' }, { t: 'picture', picture: null }, { t: 'telemetry', on: true }]);
    declare(d, { t: 'name', name: 'Alice' }); // and back: nothing to say
    expect(afterWelcome(d, auth).map((m) => m.t)).toEqual(['picture', 'telemetry']);
  });

  it('a join declares mute and share as declared last, unmuted and not sharing before', () => {
    const d = declared('Alice', null, false);
    expect(joinDeclares(d)).toEqual({ muted: false, sharing: false });
    declare(d, { t: 'mute', muted: true });
    declare(d, { t: 'share', on: true });
    expect(joinDeclares(d)).toEqual({ muted: true, sharing: true });
    declare(d, { t: 'mute', muted: false });
    expect(joinDeclares(d)).toEqual({ muted: false, sharing: true });
  });

  it('after the join, every ask to watch goes again, the latest per sharer, to friends still sharing in the call', () => {
    const d = declared('Alice', null, false);
    declare(d, { t: 'subscribe', to: 'bob', on: true });
    declare(d, { t: 'subscribe', to: 'bob', on: true, scale: 2 }); // asked again from a small screen
    declare(d, { t: 'subscribe', to: 'carol', on: true });
    declare(d, { t: 'subscribe', to: 'carol', on: false }); // stopped watching: said again too, a lost stop costs a sharer
    declare(d, { t: 'subscribe', to: 'dan', on: true });
    declare(d, { t: 'mute', muted: true }); // rides in the join
    const people = [person('bob', { sharing: true }), person('carol', { sharing: true }), person('dan', { role: 'visitor', joinSeq: null, sharing: true })];
    expect(afterJoin(d, people)).toEqual([{ t: 'subscribe', to: 'bob', on: true, scale: 2 }, { t: 'subscribe', to: 'carol', on: false }]);
    expect(afterJoin(d, [])).toEqual([]);
  });

  it('a share that ended, or a friend who left, takes the ask to watch along; a friend only reconnecting does not', () => {
    const d = declared('Alice', null, false);
    for (const to of ['bob', 'carol', 'dan', 'erin']) declare(d, { t: 'subscribe', to, on: true });
    forgetEnded(d, [person('bob', { sharing: false }), person('carol', { role: 'visitor', joinSeq: null }), person('dan', { sharing: true })]);
    forgetWatch(d, 'erin');
    const all = ['bob', 'carol', 'dan', 'erin'].map((k) => person(k, { sharing: true }));
    expect(afterJoin(d, all).map((m) => m.t === 'subscribe' && m.to)).toEqual(['carol', 'dan']);
  });

  it('leaving the call ends what was declared in it, and keeps the name, picture and opt-in', () => {
    const d = declared('Alice', '😀', true);
    declare(d, { t: 'mute', muted: true });
    declare(d, { t: 'share', on: true });
    declare(d, { t: 'subscribe', to: 'bob', on: true });
    leaveCall(d);
    expect(joinDeclares(d)).toEqual({ muted: false, sharing: false });
    expect(afterJoin(d, [person('bob', { sharing: true })])).toEqual([]);
    expect(carried(d)).toEqual({ name: 'Alice', picture: '😀', telemetry: true });
    expect([...d.values()].some(inCallOnly)).toBe(false);
  });
});
