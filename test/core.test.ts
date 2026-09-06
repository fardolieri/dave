import { describe, expect, it } from 'vitest';
import { parseClientMessage, MAX_MESSAGE_BYTES } from '../src/core/protocol';

describe('protocol', () => {
  it('parses known messages and rejects the rest', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(parseClientMessage(JSON.stringify({ t: 'echo', text: 'x' }))).toEqual({ t: 'echo', text: 'x' });
    expect(parseClientMessage(JSON.stringify({ t: 'echo' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseClientMessage('{')).toBeNull();
    expect(parseClientMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });
});
