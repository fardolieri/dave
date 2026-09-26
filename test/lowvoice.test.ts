import { describe, expect, it } from 'vitest';
import { asksLowVoice, formatDelay, lagLevel, lowVoiceSdp } from '../src/core/lowvoice';
import { extractDtlsFingerprints } from '../src/core/dtls';

// Trimmed from a Chrome offer: voice, share video, share audio (SLOT_INDEX order).
const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=fingerprint:sha-256 AB:CD:EF',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:2',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n');

const sections = (sdp: string) => sdp.split(/\r\n(?=m=)/);

describe('low bandwidth voice', () => {
  it('caps the voice section at 12 kbps in 60 ms packets and leaves the shares alone', () => {
    const low = lowVoiceSdp(OFFER);
    const [session, voice, video, shareAudio] = sections(low);
    expect(voice).toContain('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=12000;maxplaybackrate=16000;usedtx=1\r\n');
    expect(voice).toContain('a=ptime:60');
    expect(voice).toContain('a=fmtp:63 111/111'); // RED's own line untouched
    expect([session, video, shareAudio]).toEqual(sections(OFFER).filter((_, i) => i !== 1));
    expect(low.endsWith('\r\n')).toBe(true);
    expect(extractDtlsFingerprints(low)).toEqual(extractDtlsFingerprints(OFFER)); // the signature still verifies
  });
  it('applied twice changes nothing more, and replaces an existing ptime and bitrate', () => {
    const low = lowVoiceSdp(OFFER);
    expect(lowVoiceSdp(low)).toBe(low);
    const other = OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\nm=video', 'a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000\r\na=ptime:20\r\na=maxptime:20\r\nm=video');
    const voice = sections(lowVoiceSdp(other))[1]!;
    expect(voice).toContain('maxaveragebitrate=12000');
    expect(voice).not.toContain('64000');
    expect(voice.match(/a=ptime:/g)).toHaveLength(1);
    expect(voice).not.toContain('a=maxptime');
  });
  it('adds an fmtp line where Opus had none, and leaves an SDP without Opus voice as it is', () => {
    const bare = OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:63', 'a=rtpmap:63');
    expect(sections(lowVoiceSdp(bare))[1]).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxaveragebitrate=12000;maxplaybackrate=16000;usedtx=1\r\n');
    const noAudio = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
    expect(lowVoiceSdp(noAudio)).toBe(noAudio);
  });
  it('tells a description that asks for it', () => {
    expect(asksLowVoice(OFFER)).toBe(false);
    expect(asksLowVoice(lowVoiceSdp(OFFER))).toBe(true);
    expect(asksLowVoice(OFFER.replace('useinbandfec=1\r\na=rtpmap:63', 'useinbandfec=1;maxaveragebitrate=64000\r\na=rtpmap:63'))).toBe(false);
  });
});

describe('delay next to a name', () => {
  it('formats and grades a round trip', () => {
    expect(formatDelay(84.4)).toBe('84 ms');
    expect(formatDelay(1240)).toBe('1.2 s');
    expect(formatDelay(14_200)).toBe('14 s');
    expect([lagLevel(120), lagLevel(400), lagLevel(999), lagLevel(1000)]).toEqual(['ok', 'warn', 'warn', 'bad']);
  });
});
