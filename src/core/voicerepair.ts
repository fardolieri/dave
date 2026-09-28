/**
 * Voice repair (ticket 34): how lost voice packets are made up for between two friends. Opus inband FEC, which every
 * browser asks for by itself (`useinbandfec=1`): a rough copy of each packet rides in the next one, at little extra
 * data, used by the encoder once the other side reports loss. RED (RFC 2198): a full copy of the previous packet in
 * every packet, about double the voice data, for a line that drops many. Off: neither.
 *
 * Like low bandwidth voice, both the copy of a description I send and the copy I apply are rewritten, so one side's
 * choice holds both ways: a browser sends with the first codec of its remote description, and Opus reads its FEC
 * flag from it too. Only off touches the flag (`useinbandfec=0`, which no browser writes by itself): the other two
 * leave what the description says, so off on either side switches both off between the two and RED yields to it.
 * RED needs both browsers to list it (Chrome does, Firefox does not, 2026-09-28); where one lacks it the rewrite
 * finds no RED line and changes nothing there. Only the voice section is touched and fingerprints never are, so the
 * signed DTLS binding (ADR 0004) holds.
 */
import { rewriteVoice, voiceSection, withFmtpParams } from './lowvoice';

export type VoiceRepair = 'off' | 'fec' | 'red';
export const VOICE_REPAIRS: readonly VoiceRepair[] = ['off', 'fec', 'red'];
export const DEFAULT_VOICE_REPAIR: VoiceRepair = 'fec';

/** The section's RED payload type (`a=rtpmap:<pt> red/48000`), or null when the browser does not offer it. */
function redPt(body: string[]): string | null {
  for (const l of body) {
    const m = /^a=rtpmap:(\d+) red\/48000/i.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** The m-line with payload type `pt` moved to the front or the back of its list. */
function reorder(mline: string, pt: string, where: 'first' | 'last'): string {
  const parts = mline.split(' ');
  const pts = parts.slice(3).filter((p) => p !== pt);
  return [...parts.slice(0, 3), ...(where === 'first' ? [pt, ...pts] : [...pts, pt])].join(' ');
}

/** The SDP with its voice section asking for this repair. Unchanged when it has no Opus voice section. */
export function voiceRepairSdp(sdp: string, mode: VoiceRepair): string {
  return rewriteVoice(sdp, (body, pt) => {
    if (mode === 'fec') return body;
    const red = redPt(body);
    if (mode === 'off') {
      const out = withFmtpParams(body, pt, { useinbandfec: '0' });
      if (red) out[0] = reorder(out[0]!, red, 'last');
      return out;
    }
    if (!red || switchedOff(body, pt)) return body;
    return [reorder(body[0]!, red, 'first'), ...body.slice(1)];
  });
}

/** The other side switched repair off: its description carries the flag no browser writes by itself. */
const switchedOff = (body: string[], pt: string): boolean => {
  const fmtp = body.find((l) => l.startsWith(`a=fmtp:${pt} `));
  return !!fmtp && /(?:^|[; ])useinbandfec=0(?:;|$)/.test(fmtp.slice(fmtp.indexOf(' ') + 1));
};

/** Does a side applying this description send RED: its voice section lists RED before Opus? For reports and tests. */
export function sendsRed(sdp: string): boolean {
  const lines = sdp.split(/\r?\n/);
  const section = voiceSection(lines);
  if (!section) return false;
  const body = lines.slice(section.start, section.end);
  const red = redPt(body);
  if (!red) return false;
  const pts = body[0]!.split(' ').slice(3);
  return pts.indexOf(red) >= 0 && pts.indexOf(red) < pts.indexOf(section.pt);
}

/** Does this description ask for Opus inband FEC? The browsers' default; false once a side switched repair off. */
export function asksFec(sdp: string): boolean {
  const lines = sdp.split(/\r?\n/);
  const section = voiceSection(lines);
  if (!section) return false;
  const fmtp = lines.slice(section.start, section.end).find((l) => l.startsWith(`a=fmtp:${section.pt} `));
  return !!fmtp && /(?:^|[; ])useinbandfec=1(?:;|$)/.test(fmtp.slice(fmtp.indexOf(' ') + 1));
}
