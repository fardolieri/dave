import { describe, expect, it } from 'vitest';
import { normaliseName, normalisePicture, parseClientMessage, MAX_MESSAGE_BYTES, type Person } from '../src/core/protocol';
import { onMessage, presenceSnapshot, type SocketState } from '../src/core/room';
import { newBucket } from '../src/core/ratelimit';

describe('protocol', () => {
  it('parses known messages and rejects the rest', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(parseClientMessage(JSON.stringify({ t: 'text', text: ' x ' }))).toEqual({ t: 'text', text: 'x' });
    const bad = { t: 'invalid', reason: 'unrecognised message' };
    expect(parseClientMessage(JSON.stringify({ t: 'text' }))).toEqual({ ...bad, ref: 'text' });
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toEqual(bad);
    expect(parseClientMessage('{')).toEqual(bad);
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual(bad);
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toEqual({ t: 'invalid', reason: 'message too large' });
    expect(parseClientMessage(JSON.stringify({ t: 'text', text: '  ' }))).toEqual({ t: 'invalid', reason: 'empty message', ref: 'text' });
  });

  it('takes a signal far beyond 16 KB and names the type of a frame too large even for that (ticket 30)', () => {
    const to = 'a'.repeat(87);
    const sdp = `v=0\r\n${'a=candidate:1 1 udp 2122260223 2001:db8::1 54321 typ host generation 0\r\n'.repeat(400)}`;
    expect(sdp.length).toBeGreaterThan(16384);
    expect(parseClientMessage(JSON.stringify({ t: 'signal', to, data: { description: { type: 'offer', sdp } } }))).toMatchObject({ t: 'signal' });
    const huge = JSON.stringify({ t: 'signal', to, data: { description: { type: 'offer', sdp: 'x'.repeat(MAX_MESSAGE_BYTES) } } });
    expect(parseClientMessage(huge)).toEqual({ t: 'invalid', reason: 'message too large', ref: 'signal' });
  });

  it('validates auth fields', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', name: '  Dave  Smith ', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify(ok))).toEqual({ ...ok, name: 'Dave Smith' });
    expect(parseClientMessage(JSON.stringify({ ...ok, publicKey: 'not base64url!' }))).toMatchObject({ t: 'invalid' });
    expect(parseClientMessage(JSON.stringify({ ...ok, name: '   ' }))).toEqual({ t: 'invalid', reason: 'invalid name', ref: 'auth' });
    expect(parseClientMessage(JSON.stringify({ ...ok, name: 'x'.repeat(33) }))).toEqual({ t: 'invalid', reason: 'invalid name', ref: 'auth' });
    const authKey = 'a'.repeat(43);
    expect(parseClientMessage(JSON.stringify({ ...ok, authKey }))).toEqual({ ...ok, name: 'Dave Smith', authKey });
    expect(parseClientMessage(JSON.stringify({ ...ok, authKey: 'short' }))).toMatchObject({ t: 'invalid' });
    expect(parseClientMessage(JSON.stringify({ ...ok, authKey: 42 }))).toMatchObject({ t: 'invalid' });
  });

  it('takes one emoji as the profile picture, in auth and on its own; null clears it', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', name: 'Dave', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: ' 🐱 ' }))).toEqual({ ...ok, picture: '🐱' });
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: null }))).toEqual(ok);
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: 'ab' }))).toEqual({ t: 'invalid', reason: 'invalid picture', ref: 'auth' });
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: '🐱🐱' }))).toEqual({ t: 'invalid', reason: 'invalid picture', ref: 'auth' });
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: 7 }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'auth' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: '👨‍👩‍👧‍👦' }))).toEqual({ t: 'picture', picture: '👨‍👩‍👧‍👦' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: null }))).toEqual({ t: 'picture', picture: null });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: '' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'picture' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: 'x' }))).toEqual({ t: 'invalid', reason: 'invalid picture', ref: 'picture' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture' }))).toEqual({ t: 'invalid', reason: 'unrecognised message', ref: 'picture' });
    expect(normalisePicture('☠')).toBeNull(); // text-presentation symbol without the emoji selector
    expect(normalisePicture('🇩🇪')).toBe('🇩🇪');
  });

  it('takes the PostHog opt-in in auth and on its own (ticket 32)', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', name: 'Dave', hmac: 'aa', signature: 'bb' };
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
  const person = (publicKey: string, name: string): Person => ({ publicKey, fingerprint: publicKey.slice(0, 6), name, role: 'visitor', joinSeq: null, sharing: false, muted: false });
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
    expect(snapshot.people.map((p) => [p.publicKey, p.name])).toEqual([['k-alice', 'Alice renamed'], ['k-bob', 'Bob']]);
  });
});

describe('telemetry consent on the server (ticket 32)', () => {
  const person: Person = { publicKey: 'k', fingerprint: 'f', name: 'Alice', role: 'visitor', joinSeq: null, sharing: false, muted: false };
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
