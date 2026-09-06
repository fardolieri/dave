import { describe, expect, it } from 'vitest';
import { normaliseName, parseClientMessage, MAX_MESSAGE_BYTES } from '../src/core/protocol';

describe('protocol', () => {
  it('parses known messages and rejects the rest', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(parseClientMessage(JSON.stringify({ t: 'text', text: ' x ' }))).toEqual({ t: 'text', text: 'x' });
    expect(parseClientMessage(JSON.stringify({ t: 'text' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseClientMessage('{')).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });

  it('validates auth fields', () => {
    const ok = { t: 'auth', publicKey: 'AbC-_', name: '  Dave  Smith ', hmac: 'aa', signature: 'bb' };
    expect(parseClientMessage(JSON.stringify(ok))).toEqual({ ...ok, name: 'Dave Smith' });
    expect(parseClientMessage(JSON.stringify({ ...ok, publicKey: 'not base64url!' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...ok, name: '   ' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...ok, name: 'x'.repeat(33) }))).toBeNull();
  });

  it('normalises names', () => {
    expect(normaliseName(' a  b ')).toBe('a b');
    expect(normaliseName('')).toBeNull();
    expect(normaliseName('x'.repeat(32))).toHaveLength(32);
    expect(normaliseName('x'.repeat(33))).toBeNull();
  });
});
