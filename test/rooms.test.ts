import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_NAME, authKeyOf, formatInviteFragment, isRoomId, newRoomSecret, parseInviteFragment, roomIdOf } from '../src/core/rooms';

describe('room derivation', () => {
  it('derives a stable room id and auth key from the secret, distinct from each other and per secret', async () => {
    const id = await roomIdOf('a secret');
    expect(id).toBe(await roomIdOf('a secret'));
    expect(isRoomId(id)).toBe(true);
    expect(id).not.toBe(await authKeyOf('a secret'));
    expect(id).not.toBe(await roomIdOf('another secret'));
    expect(await authKeyOf('a secret')).not.toBe(await authKeyOf('another secret'));
  });

  it('new secrets are random base64url of 16 bytes', () => {
    const a = newRoomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newRoomSecret()).not.toBe(a);
  });

  it('accepts only 43-character base64url room ids', () => {
    expect(isRoomId('a'.repeat(43))).toBe(true);
    expect(isRoomId('a'.repeat(42))).toBe(false);
    expect(isRoomId('a'.repeat(42) + '+')).toBe(false);
    expect(isRoomId('')).toBe(false);
  });
});

describe('invite fragments', () => {
  it('round-trips secret and name, with characters that need escaping', () => {
    const link = { secret: 'S3cr-t_x', name: 'Game night / Fridays #2' };
    const fragment = formatInviteFragment(link);
    expect(fragment.startsWith('#')).toBe(true);
    expect(parseInviteFragment(fragment)).toEqual(link);
  });

  it('reads links from before rooms had names as the default room', () => {
    expect(parseInviteFragment('#the-passphrase')).toEqual({ secret: 'the-passphrase', name: DEFAULT_ROOM_NAME });
    expect(parseInviteFragment('#with%20space')).toEqual({ secret: 'with space', name: DEFAULT_ROOM_NAME });
    expect(parseInviteFragment('#abc/')).toEqual({ secret: 'abc', name: DEFAULT_ROOM_NAME }); // an empty name falls back too
  });

  it('rejects an empty fragment', () => {
    expect(parseInviteFragment('')).toBeNull();
    expect(parseInviteFragment('#')).toBeNull();
    expect(parseInviteFragment('#/name-only')).toBeNull();
  });
});
