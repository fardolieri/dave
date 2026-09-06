import { describe, expect, it } from 'vitest';
import { initiatesTo, isPolite, nextJoinSeq } from '../src/core/mesh';
import { STUN_ONLY, parseIceServers, turnCredentialRequest } from '../src/core/turn';
import type { Person } from '../src/core/protocol';

const person = (name: string, joinSeq: number | null): Person => ({ publicKey: name, fingerprint: 'xxxxxx', name, role: joinSeq ? 'participant' : 'visitor', joinSeq, sharing: false, muted: false });

describe('mesh rules', () => {
  it('polite is the lower key, symmetric and stable', () => {
    expect(isPolite('A', 'B')).toBe(true);
    expect(isPolite('B', 'A')).toBe(false);
  });
  it('the newcomer initiates', () => {
    expect(initiatesTo(person('x', 5), person('y', 3))).toBe(true);
    expect(initiatesTo(person('x', 3), person('y', 5))).toBe(false);
    expect(initiatesTo(person('x', null), person('y', 5))).toBe(false);
  });
  it('join sequence is one more than the highest attached', () => {
    expect(nextJoinSeq([])).toBe(1);
    expect(nextJoinSeq([person('a', 2), person('b', null), person('c', 7)])).toBe(8);
  });
});

describe('turn credentials', () => {
  it('builds the Cloudflare generate-ice-servers request', () => {
    const r = turnCredentialRequest('key123', 'tok', 43200);
    expect(r.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
    expect(r.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(r.body)).toEqual({ ttl: 43200 });
  });
  it('parses a well-formed reply and rejects junk', () => {
    expect(parseIceServers({ iceServers: [{ urls: ['turn:x:3478'], username: 'u', credential: 'c' }] })).toEqual([{ urls: ['turn:x:3478'], username: 'u', credential: 'c' }]);
    expect(parseIceServers({ iceServers: [{ nope: 1 }] })).toBeNull();
    expect(parseIceServers('x')).toBeNull();
    expect(STUN_ONLY[0]!.urls).toMatch(/^stun:/);
  });
});

describe('turn helpers', () => {
  it('orders turns entries last and finds the minted username', async () => {
    const { orderIceServers, turnUsername, turnRevokeRequest } = await import('../src/core/turn');
    const servers = [
      { urls: 'turns:turn.cloudflare.com:443?transport=tcp', username: 'u1', credential: 'c' },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'c' },
    ];
    expect(orderIceServers(servers).map((s) => String(s.urls))).toEqual(['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
    expect(turnUsername(servers)).toBe('u1');
    expect(turnRevokeRequest('k', 't', 'a b').url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/k/credentials/a%20b/revoke');
  });
});
