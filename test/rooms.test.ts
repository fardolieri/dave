import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_NAME, authKeyOf, formatInviteFragment, isRoomId, newRoomSecret, parseInviteFragment, parseInviteText, roomIdOf } from '../src/core/rooms';

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

describe('pasted invite text', () => {
  const link = { secret: 'AbCdEfGhIjKlMnOp-_0123', name: 'Game night' };
  const fragment = formatInviteFragment(link);

  it('reads a whole URL, its fragment alone, or the bare secret and name', () => {
    expect(parseInviteText(`https://dave.example/${fragment}`)).toEqual(link);
    expect(parseInviteText(`  ${fragment}\n`)).toEqual(link);
    expect(parseInviteText(fragment.slice(1))).toEqual(link);
    expect(parseInviteText(link.secret)).toEqual({ secret: link.secret, name: DEFAULT_ROOM_NAME });
  });

  it('takes the fragment from any origin or path', () => {
    expect(parseInviteText(`http://localhost:5173/some/path?q=1${fragment}`)).toEqual(link);
  });

  it('rejects a URL without a fragment, prose, and empty text', () => {
    expect(parseInviteText('https://dave.example/')).toBeNull();
    expect(parseInviteText('https://dave.example/#')).toBeNull();
    expect(parseInviteText('just some text https://x.example/')).toBeNull();
    expect(parseInviteText('see you at 8')).toBeNull();
    expect(parseInviteText('')).toBeNull();
    expect(parseInviteText('   ')).toBeNull();
  });

  it('reads a link a mail or messenger broke over lines or marked with invisible characters', () => {
    const s = link.secret;
    expect(parseInviteText(`https://dave.example/#${s.slice(0, 11)}\n${s.slice(11)}/Game%20night`)).toEqual(link);
    expect(parseInviteText(`https://dave.example/#${s.slice(0, 11)}\r\n${s.slice(11)}/Game%20night`)).toEqual(link);
    expect(parseInviteText(`\u200B${fragment}\u200B`)).toEqual(link);
    expect(parseInviteText(`https://dave.example/#${s}\uFEFF`)).toEqual({ secret: s, name: DEFAULT_ROOM_NAME });
    expect(parseInviteText('see you\nat 8')).toBeNull();
  });

  it('rejects anything whose secret is not one the app makes, so a typo cannot open a new empty room', () => {
    expect(parseInviteText('hello')).toBeNull();
    expect(parseInviteText('the-passphrase/Game night')).toBeNull();
    expect(parseInviteText('https://dave.example/#hello')).toBeNull();
    expect(parseInviteText(`https://dave.example/#${link.secret.slice(1)}/Game%20night`)).toBeNull(); // one character short
    expect(parseInviteText(`https://dave.example/#${link.secret}x/Game%20night`)).toBeNull(); // one too many
    expect(parseInviteText(`https://dave.example/#${link.secret.slice(1)}+/Game%20night`)).toBeNull(); // not base64url
  });
});
