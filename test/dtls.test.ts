import { describe, expect, it } from 'vitest';
import { dtlsBindingBytes, extractDtlsFingerprints, signDescription, verifyDescription } from '../src/core/dtls';
import { exportPublicKey, generateIdentityKeyPair, toBase64Url } from '../src/core/identity';

const FP_A = '7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08';
const FP_B = 'C3:5A:1E:90:9E:D2:0B:3E:77:00:0F:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23';
const sdp = (fp = FP_A) => [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', 'a=ice-pwd:efghijklmnopqrstuvwxyz',
  `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', `a=fingerprint:sha-256 ${fp}`, 'a=mid:1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', `a=fingerprint:sha-256 ${fp}`, 'a=mid:2',
].join('\r\n') + '\r\n';

async function identity() {
  const keys = await generateIdentityKeyPair();
  return { keys, publicKey: toBase64Url(await exportPublicKey(keys.publicKey)) };
}

describe('DTLS fingerprint extraction', () => {
  it('collects every a=fingerprint line once, normalised', () => {
    expect(extractDtlsFingerprints(sdp())).toEqual([`sha-256 ${FP_A}`]);
    const mixed = `a=fingerprint:SHA-256 ${FP_A.toLowerCase()}\na=fingerprint:sha-256 ${FP_B}\n`;
    expect(extractDtlsFingerprints(mixed)).toEqual([`sha-256 ${FP_A}`, `sha-256 ${FP_B}`]);
  });

  it('ignores malformed lines and SDP without fingerprints', () => {
    expect(extractDtlsFingerprints('v=0\r\na=fingerprint:sha-256 not-hex\r\n')).toEqual([]);
    expect(extractDtlsFingerprints('v=0')).toEqual([]);
  });

  it('binds the fingerprints to both identities with a domain tag', () => {
    const bytes = new TextDecoder().decode(dtlsBindingBytes('me', 'you', ['sha-256 AA:BB']));
    expect(bytes).toBe('dave dtls binding v1\nme\nyou\nsha-256 AA:BB');
  });
});

describe('description signing', () => {
  it('a description signed by the sender verifies at the recipient', async () => {
    const alice = await identity();
    const bob = await identity();
    const signature = await signDescription({ privateKey: alice.keys.privateKey, from: alice.publicKey, to: bob.publicKey, sdp: sdp() });
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await verifyDescription({ from: alice.publicKey, to: bob.publicKey, sdp: sdp(), signature: signature! })).toBe('ok');
  });

  it('a swapped fingerprint (a man in the middle) is refused', async () => {
    const alice = await identity();
    const bob = await identity();
    const signature = await signDescription({ privateKey: alice.keys.privateKey, from: alice.publicKey, to: bob.publicKey, sdp: sdp() });
    expect(await verifyDescription({ from: alice.publicKey, to: bob.publicKey, sdp: sdp(FP_B), signature: signature! })).toBe('bad signature');
  });

  it('a description signed for someone else, or by someone else, is refused', async () => {
    const alice = await identity();
    const bob = await identity();
    const carol = await identity();
    const forBob = await signDescription({ privateKey: alice.keys.privateKey, from: alice.publicKey, to: bob.publicKey, sdp: sdp() });
    expect(await verifyDescription({ from: alice.publicKey, to: carol.publicKey, sdp: sdp(), signature: forBob! })).toBe('bad signature');
    // the server relabels Carol's offer as coming from Alice
    const byCarol = await signDescription({ privateKey: carol.keys.privateKey, from: carol.publicKey, to: bob.publicKey, sdp: sdp() });
    expect(await verifyDescription({ from: alice.publicKey, to: bob.publicKey, sdp: sdp(), signature: byCarol! })).toBe('bad signature');
  });

  it('unsigned, unsignable, and malformed inputs fail closed', async () => {
    const alice = await identity();
    const bob = await identity();
    expect(await signDescription({ privateKey: alice.keys.privateKey, from: alice.publicKey, to: bob.publicKey, sdp: 'v=0' })).toBeNull();
    expect(await verifyDescription({ from: alice.publicKey, to: bob.publicKey, sdp: sdp(), signature: undefined })).toBe('unsigned');
    const signature = await signDescription({ privateKey: alice.keys.privateKey, from: alice.publicKey, to: bob.publicKey, sdp: sdp() });
    expect(await verifyDescription({ from: alice.publicKey, to: bob.publicKey, sdp: 'v=0', signature: signature! })).toBe('no fingerprint');
    expect(await verifyDescription({ from: 'AAAA', to: bob.publicKey, sdp: sdp(), signature: signature! })).toBe('bad key');
    expect(await verifyDescription({ from: alice.publicKey, to: bob.publicKey, sdp: sdp(), signature: '!!!' })).toBe('bad signature');
  });
});
