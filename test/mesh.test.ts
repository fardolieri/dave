import { describe, expect, it } from 'vitest';
import { initiatesTo, isPolite, nextJoinSeq, stuckDelay } from '../src/core/mesh';
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

describe('share bandwidth rule', () => {
  it('splits the budget with a ceiling and a floor', async () => {
    const { perViewerBitrate } = await import('../src/core/mesh');
    expect(perViewerBitrate(0)).toBe(2_500_000);
    expect(perViewerBitrate(1)).toBe(2_500_000);
    expect(perViewerBitrate(3)).toBe(2_500_000); // 8/3 Mbps capped
    expect(perViewerBitrate(4)).toBe(2_000_000);
    expect(perViewerBitrate(7)).toBe(1_142_857);
    expect(perViewerBitrate(20)).toBe(1_000_000);
  });
});

describe('stuckDelay', () => {
  it('lets the offerer act first, staggers the other side, doubles and caps', () => {
    expect(stuckDelay(0, true)).toBe(15_000);
    expect(stuckDelay(0, false)).toBe(20_000);
    expect(stuckDelay(1, true)).toBe(30_000);
    expect(stuckDelay(5, true)).toBe(60_000);
    expect(stuckDelay(5, false)).toBe(65_000);
  });
});
