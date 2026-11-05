import { describe, expect, it } from 'vitest';
import { normaliseName, normalisePicture, parseClientMessage, MAX_MESSAGE_BYTES, MAX_SEALED_FILE_LENGTH, MAX_SEALED_LENGTH, MAX_SEALED_PROFILE_LENGTH, APP_OUT_OF_DATE, OUT_OF_DATE, type WirePerson as Person } from '../src/core/protocol';
import { onMessage, presenceSnapshot, type SocketState } from '../src/core/room';
import { newBucket } from '../src/core/ratelimit';

describe('protocol', () => {
  it('a join or ice request may name itself; one without an id, from an older client, is taken as before', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'join', muted: false, id: 7 }))).toEqual({ t: 'join', muted: false, sharing: false, id: 7 });
    expect(parseClientMessage(JSON.stringify({ t: 'join', muted: true }))).toEqual({ t: 'join', muted: true, sharing: false });
    expect(parseClientMessage(JSON.stringify({ t: 'ice', id: 8 }))).toEqual({ t: 'ice', id: 8 });
    expect(parseClientMessage(JSON.stringify({ t: 'ice' }))).toEqual({ t: 'ice' });
    for (const id of ['7', -1, 1.5, null]) {
      expect(parseClientMessage(JSON.stringify({ t: 'join', muted: false, id }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'join' });
      expect(parseClientMessage(JSON.stringify({ t: 'ice', id }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'ice' });
    }
  });

  it('parses known messages and rejects the rest', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(parseClientMessage(JSON.stringify({ t: 'sealed', sealed: 'c2Vh_-', id: 'a1b2' }))).toEqual({ t: 'sealed', sealed: 'c2Vh_-', id: 'a1b2' });
    for (const id of [undefined, 7, '', 'no spaces', 'x'.repeat(33)]) {
      expect(parseClientMessage(JSON.stringify({ t: 'sealed', sealed: 'c2Vh', id }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'sealed' });
    }
    for (const sealed of [undefined, '', 'not base64!', 7]) {
      expect(parseClientMessage(JSON.stringify({ t: 'sealed', sealed, id: 'a1b2' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'sealed' });
    }
    // ADR 0011: a private text routed to one friend by key is from an app before rooms of two, however it is made.
    for (const m of [{ t: 'private', to: 'pkB', sealed: 'c2Vh', id: 'a1b2' }, { t: 'private', to: 'pkB', sealed: 'c2Vh', id: 'a1b2', file: true }, { t: 'private' }]) {
      expect(parseClientMessage(JSON.stringify(m))).toEqual({ t: 'invalid', reason: APP_OUT_OF_DATE, ref: 'private' });
    }
    const bad = { t: 'invalid', reason: 'unrecognised message' };
    // ADR 0005: only an app from before sealed texts sends a plain one.
    expect(parseClientMessage(JSON.stringify({ t: 'text', text: 'x', id: 'a1b2' }))).toEqual({ t: 'invalid', reason: OUT_OF_DATE, ref: 'text' });
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toEqual(bad);
    expect(parseClientMessage('{')).toEqual(bad);
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual(bad);
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toEqual({ t: 'invalid', reason: 'message too large' });
  });

  it('takes a signal far beyond 16 KB and names the type of a frame too large even for that (ticket 30)', () => {
    const to = 'a'.repeat(87);
    const sdp = `v=0\r\n${'a=candidate:1 1 udp 2122260223 2001:db8::1 54321 typ host generation 0\r\n'.repeat(400)}`;
    expect(sdp.length).toBeGreaterThan(16384);
    expect(parseClientMessage(JSON.stringify({ t: 'signal', to, data: { description: { type: 'offer', sdp } } }))).toMatchObject({ t: 'signal' });
    const huge = JSON.stringify({ t: 'signal', to, data: { description: { type: 'offer', sdp: 'x'.repeat(MAX_MESSAGE_BYTES) } } });
    expect(parseClientMessage(huge)).toEqual({ t: 'invalid', reason: 'message too large', ref: 'signal' });
  });

  it('validates auth fields: the profile sealed (ADR 0010), a name in plain refused as from an app out of date', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', profile: 'cHJvZmlsZQ', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify(ok))).toEqual(ok);
    expect(parseClientMessage(JSON.stringify({ ...ok, publicKey: 'not base64url!' }))).toMatchObject({ t: 'invalid' });
    const { profile: _sealed, ...plain } = ok;
    expect(parseClientMessage(JSON.stringify({ ...plain, name: 'Dave' }))).toEqual({ t: 'invalid', reason: APP_OUT_OF_DATE, ref: 'auth' });
    expect(parseClientMessage(JSON.stringify(plain))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'auth' });
    for (const profile of ['', 'not base64!', 7, 'a'.repeat(MAX_SEALED_PROFILE_LENGTH + 1)]) {
      expect(parseClientMessage(JSON.stringify({ ...ok, profile }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'auth' });
    }
    // A name and picture beside the profile are not taken, so not passed on either.
    expect(parseClientMessage(JSON.stringify({ ...ok, name: 'Dave', picture: '🐱' }))).toEqual(ok);
    const authKey = 'a'.repeat(43);
    expect(parseClientMessage(JSON.stringify({ ...ok, authKey }))).toEqual({ ...ok, authKey });
    expect(parseClientMessage(JSON.stringify({ ...ok, authKey: 'short' }))).toMatchObject({ t: 'invalid' });
    expect(parseClientMessage(JSON.stringify({ ...ok, authKey: 42 }))).toMatchObject({ t: 'invalid' });
    // ADR 0007: the private text key and its signature, of the lengths a P-256 point and signature have.
    const privateTexts = { key: 'k'.repeat(87), sig: 's'.repeat(86) };
    expect(parseClientMessage(JSON.stringify({ ...ok, privateTexts }))).toEqual({ ...ok, privateTexts });
    // One of another shape is left out: the friend gets in, without private texts.
    for (const bad of [null, 'k', { key: 'k'.repeat(86), sig: 's'.repeat(86) }, { key: 'k'.repeat(87) }, { key: 'k'.repeat(87), sig: '!'.repeat(86) }]) {
      expect(parseClientMessage(JSON.stringify({ ...ok, privateTexts: bad }))).toEqual(ok);
    }
  });

  it('takes a new profile sealed on its own; a name or picture in plain is from an app out of date', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'profile', profile: 'cHJvZmlsZQ' }))).toEqual({ t: 'profile', profile: 'cHJvZmlsZQ' });
    expect(parseClientMessage(JSON.stringify({ t: 'profile' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'profile' });
    expect(parseClientMessage(JSON.stringify({ t: 'name', name: 'Dave' }))).toEqual({ t: 'invalid', reason: APP_OUT_OF_DATE, ref: 'name' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: '🐱' }))).toEqual({ t: 'invalid', reason: APP_OUT_OF_DATE, ref: 'picture' });
    expect(normalisePicture('☠')).toBeNull(); // text-presentation symbol without the emoji selector
    expect(normalisePicture('🇩🇪')).toBe('🇩🇪');
  });

  it('takes the PostHog opt-in in auth and on its own (ticket 32)', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', profile: 'cHJvZmlsZQ', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify({ ...ok, telemetry: true }))).toEqual({ ...ok, telemetry: true });
    expect(parseClientMessage(JSON.stringify({ ...ok, telemetry: 'yes' }))).toEqual(ok);
    expect(parseClientMessage(JSON.stringify({ t: 'telemetry', on: false }))).toEqual({ t: 'telemetry', on: false });
    expect(parseClientMessage(JSON.stringify({ t: 'telemetry' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'telemetry' });
  });

  it('normalises names', () => {
    expect(normaliseName(' a  b ')).toBe('a b');
    expect(normaliseName('')).toBeNull();
    expect(normaliseName('x'.repeat(32))).toHaveLength(32);
    expect(normaliseName('x'.repeat(33))).toBeNull();
  });
});

describe('presenceSnapshot', () => {
  const person = (publicKey: string, name: string): Person => ({ publicKey, fingerprint: publicKey.slice(0, 6), profile: name, role: 'visitor', joinSeq: null, sharing: false, muted: false });
  const attached = (publicKey: string, name: string, attachedAt: number): SocketState => ({ stage: 'attached', person: person(publicKey, name), bucket: { tokens: 1, at: attachedAt }, attachedAt });

  it('lists each identity once, from its newest socket, and skips sockets that are closing or unauthenticated', () => {
    const snapshot = presenceSnapshot([
      attached('k-alice', 'Alice', 1000),
      { stage: 'challenge', nonce: 'n', attempts: 0, since: 0 },
      attached('k-bob', 'Bob', 2000),
      attached('k-alice', 'Alice renamed', 3000), // the reconnect the server has not yet seen the old socket die for
      { stage: 'closing' },
      null,
    ]);
    expect(snapshot.people.map((p) => [p.publicKey, p.profile])).toEqual([['k-alice', 'Alice renamed'], ['k-bob', 'Bob']]);
  });
});

describe('telemetry consent on the server (ticket 32)', () => {
  const person: Person = { publicKey: 'k', fingerprint: 'f', profile: 'cHJvZmlsZQ', role: 'visitor', joinSeq: null, sharing: false, muted: false };
  const ctx = { authKey: 'a', now: 0, others: [], mintIce: async () => ({ iceServers: [], turnUser: null }) };
  const attached: SocketState = { stage: 'attached', person, bucket: newBucket(0), attachedAt: 0 };

  it('a refused frame says whether its sender opted in, and the opt-in follows the telemetry message', async () => {
    expect((await onMessage(attached, '{', ctx)).rejected?.telemetry).toBe(false);
    const on = await onMessage(attached, JSON.stringify({ t: 'telemetry', on: true }), ctx);
    expect(on.replies).toEqual([]);
    expect((await onMessage(on.state, '{', ctx)).rejected?.telemetry).toBe(true);
    const off = await onMessage(on.state, JSON.stringify({ t: 'telemetry', on: false }), ctx);
    expect((await onMessage(off.state, '{', ctx)).rejected?.telemetry).toBe(false);
  });

  it('never shows the opt-in in presence', async () => {
    const on = await onMessage(attached, JSON.stringify({ t: 'telemetry', on: true }), ctx);
    expect(presenceSnapshot([on.state]).people).toEqual([person]);
  });
});

describe('who watches a share, in presence', () => {
  const person: Person = { publicKey: 'k-alice', fingerprint: 'f', profile: 'cHJvZmlsZQ', role: 'participant', joinSeq: 1, sharing: false, muted: false };
  const ctx = { authKey: 'a', now: 0, others: [], mintIce: async () => ({ iceServers: [], turnUser: null }) };
  const attached: SocketState = { stage: 'attached', person, bucket: newBucket(0), attachedAt: 0 };
  const send = (state: SocketState, m: object) => onMessage(state, JSON.stringify(m), ctx);
  const viewersOf = (state: SocketState) => presenceSnapshot([state]).people[0]!.viewers;

  it('takes a list of viewers with a share, and refuses one that is not a list of keys or too long', () => {
    const key = (c: string) => c.repeat(87);
    expect(parseClientMessage(JSON.stringify({ t: 'share', on: true, viewers: [key('b'), key('b'), key('c')] }))).toEqual({ t: 'share', on: true, viewers: [key('b'), key('c')] });
    expect(parseClientMessage(JSON.stringify({ t: 'share', on: true }))).toEqual({ t: 'share', on: true });
    for (const viewers of [key('b'), [7], ['not a key!'], ['k-bob'], [key('b') + 'x'.repeat(900)], Array.from({ length: 33 }, (_, i) => `${i}`.padEnd(87, 'x'))]) {
      expect(parseClientMessage(JSON.stringify({ t: 'share', on: true, viewers }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'share' });
    }
  });

  it('shows the sharer\'s viewers while sharing; a share without a list keeps the last one, its end and a leave drop it', async () => {
    const [bob, carol] = ['b'.repeat(87), 'c'.repeat(87)];
    const on = await send(attached, { t: 'share', on: true, viewers: [bob] });
    expect(on.presenceChanged).toBe(true);
    expect(viewersOf(on.state)).toEqual([bob]);
    const same = await send(on.state, { t: 'share', on: true, viewers: [bob] });
    expect(same.presenceChanged).toBeUndefined();
    const more = await send(on.state, { t: 'share', on: true, viewers: [bob, carol] });
    expect(more.presenceChanged).toBe(true);
    expect(viewersOf((await send(more.state, { t: 'share', on: true })).state)).toEqual([bob, carol]); // an app from before
    expect(viewersOf((await send(more.state, { t: 'share', on: true, viewers: [] })).state)).toBeUndefined();
    expect(viewersOf((await send(more.state, { t: 'share', on: false, viewers: [bob] })).state)).toBeUndefined();
    expect(viewersOf((await send(more.state, { t: 'leave' })).state)).toBeUndefined();
    expect(viewersOf((await send(more.state, { t: 'join', muted: false, sharing: true })).state)).toEqual([bob, carol]);
    expect(viewersOf((await send(more.state, { t: 'join', muted: false })).state)).toBeUndefined();
  });
});
