import { describe, expect, it } from 'vitest';
import { asksFec, sendsRed, voiceRepairSdp } from '../src/core/voicerepair';
import { lowVoiceSdp } from '../src/core/lowvoice';
import { extractDtlsFingerprints } from '../src/core/dtls';

// Trimmed from a Chrome offer: voice with Opus and RED, share video, share audio.
const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8',
  'c=IN IP4 0.0.0.0', 'a=fingerprint:sha-256 AB:CD:EF', 'a=mid:0',
  'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111', 'a=rtpmap:9 G722/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP8/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63', 'a=mid:2', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:63 red/48000/2',
  '',
].join('\r\n');
// Firefox: Opus only, its own payload type, no RED.
const FIREFOX = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 109 9 0 8', 'a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1', 'a=rtpmap:109 opus/48000/2', 'a=rtpmap:9 G722/8000/1', ''].join('\r\n');
const voiceMline = (sdp: string) => sdp.split('\r\n').find((l) => l.startsWith('m=audio '));
const voiceFmtp = (sdp: string) => sdp.split('\r\n').find((l) => l.startsWith('a=fmtp:111 ') || l.startsWith('a=fmtp:109 '));

describe('voiceRepairSdp', () => {
  it('changes nothing for fec: the browser asks for it by itself, and an off from the other side stands', () => {
    expect(voiceRepairSdp(OFFER, 'fec')).toBe(OFFER);
    expect(voiceRepairSdp(FIREFOX, 'fec')).toBe(FIREFOX);
    const off = voiceRepairSdp(OFFER, 'off');
    expect(voiceRepairSdp(off, 'fec')).toBe(off);
  });
  it('puts RED first in the voice m-line for red, and only there', () => {
    const out = voiceRepairSdp(OFFER, 'red');
    expect(voiceMline(out)).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 63 111 9 0 8');
    expect(out.split('\r\n').filter((l) => l.startsWith('m=audio '))[1]).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 111 63'); // the share audio section
    expect(voiceFmtp(out)).toBe('a=fmtp:111 minptime=10;useinbandfec=1');
    expect(sendsRed(out)).toBe(true);
    expect(voiceRepairSdp(out, 'red')).toBe(out); // idempotent
  });
  it('switches FEC off and puts RED last for off', () => {
    const out = voiceRepairSdp(OFFER, 'off');
    expect(voiceMline(out)).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 111 9 0 8 63');
    expect(voiceFmtp(out)).toBe('a=fmtp:111 minptime=10;useinbandfec=0');
    expect(asksFec(out)).toBe(false);
    expect(sendsRed(out)).toBe(false);
    expect(voiceRepairSdp(out, 'red')).toBe(out); // an off from the other side wins over red
  });
  it('changes nothing about RED where the browser lacks it, and still sets the FEC flag', () => {
    expect(voiceRepairSdp(FIREFOX, 'red')).toBe(FIREFOX);
    expect(voiceFmtp(voiceRepairSdp(FIREFOX, 'off'))).toBe('a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=0');
    expect(sendsRed(FIREFOX)).toBe(false);
  });
  it('composes with low bandwidth voice and touches no fingerprint', () => {
    const out = voiceRepairSdp(lowVoiceSdp(OFFER), 'red');
    expect(voiceFmtp(out)).toBe('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=12000;maxplaybackrate=16000;usedtx=1');
    expect(sendsRed(out)).toBe(true);
    expect(extractDtlsFingerprints(out)).toEqual(extractDtlsFingerprints(OFFER));
  });
  it('reads a description that asks for RED or FEC', () => {
    expect(sendsRed(OFFER)).toBe(false);
    expect(asksFec(OFFER)).toBe(true);
    expect(asksFec('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n')).toBe(false);
  });
});
