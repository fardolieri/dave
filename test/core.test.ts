import { describe, expect, it } from 'vitest';
import { normaliseName, normalisePicture, parseClientMessage, MAX_MESSAGE_BYTES, type Person } from '../src/core/protocol';
import { presenceSnapshot, type SocketState } from '../src/core/room';

describe('protocol', () => {
  it('parses known messages and rejects the rest', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(parseClientMessage(JSON.stringify({ t: 'text', text: ' x ' }))).toEqual({ t: 'text', text: 'x' });
    const bad = { t: 'invalid', reason: 'unrecognised message' };
    expect(parseClientMessage(JSON.stringify({ t: 'text' }))).toEqual(bad);
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toEqual(bad);
    expect(parseClientMessage('{')).toEqual(bad);
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual(bad);
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toEqual(bad);
    expect(parseClientMessage(JSON.stringify({ t: 'text', text: '  ' }))).toEqual({ t: 'invalid', reason: 'empty message' });
  });

  it('validates auth fields', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', name: '  Dave  Smith ', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify(ok))).toEqual({ ...ok, name: 'Dave Smith' });
    expect(parseClientMessage(JSON.stringify({ ...ok, publicKey: 'not base64url!' }))).toMatchObject({ t: 'invalid' });
    expect(parseClientMessage(JSON.stringify({ ...ok, name: '   ' }))).toEqual({ t: 'invalid', reason: 'invalid name' });
    expect(parseClientMessage(JSON.stringify({ ...ok, name: 'x'.repeat(33) }))).toEqual({ t: 'invalid', reason: 'invalid name' });
  });

  it('takes one emoji as the profile picture, in auth and on its own; null clears it', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', name: 'Dave', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: ' 🐱 ' }))).toEqual({ ...ok, picture: '🐱' });
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: null }))).toEqual(ok);
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: 'ab' }))).toEqual({ t: 'invalid', reason: 'invalid picture' });
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: '🐱🐱' }))).toEqual({ t: 'invalid', reason: 'invalid picture' });
    expect(parseClientMessage(JSON.stringify({ ...ok, picture: 7 }))).toEqual({ t: 'invalid', reason: 'unrecognised message' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: '👨‍👩‍👧‍👦' }))).toEqual({ t: 'picture', picture: '👨‍👩‍👧‍👦' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: null }))).toEqual({ t: 'picture', picture: null });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: '' }))).toEqual({ t: 'invalid', reason: 'unrecognised message' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture', picture: 'x' }))).toEqual({ t: 'invalid', reason: 'invalid picture' });
    expect(parseClientMessage(JSON.stringify({ t: 'picture' }))).toEqual({ t: 'invalid', reason: 'unrecognised message' });
    expect(normalisePicture('☠')).toBeNull(); // text-presentation symbol without the emoji selector
    expect(normalisePicture('🇩🇪')).toBe('🇩🇪');
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
