// Low bandwidth voice (ticket 27): the voice travels as Opus at 12 kbps in 60 ms packets instead of about 32 kbps in
// 20 ms ones, so a thin or overloaded line does not queue it up for seconds. Nothing on the audio path changes: Opus
// takes its bitrate and packet length from the other side's description, so the voice section of every description is
// rewritten on its way. The copy I send asks the other side to send me less; the copy I apply before
// setRemoteDescription makes my own encoder send less. Only the voice section (the first audio section, SLOT_INDEX
// order) is touched, and fingerprints never are, so the signed DTLS binding (ADR 0004) holds. Runtime-neutral, no imports.

export const LOW_VOICE_BPS = 12_000;
export const LOW_VOICE_PTIME_MS = 60;
/**
 * The least a friend's voice waits before it plays while low bandwidth voice holds between us (ticket 28). A line that
 * queues delivers packets in bursts; the browser's own buffer stays as short as it can and runs dry in between.
 */
export const LOW_VOICE_BUFFER_MS = 200;
/** Opus fmtp parameters for the voice: the bitrate cap, wideband playback (all 12 kbps carry), silence not sent. */
const LOW_OPUS_PARAMS: Record<string, string> = { maxaveragebitrate: String(LOW_VOICE_BPS), maxplaybackrate: '16000', usedtx: '1' };

/** The voice section's line range [start, end) and its Opus payload type, or null when there is none. */
export function voiceSection(lines: string[]): { start: number; end: number; pt: string } | null {
  const start = lines.findIndex((l) => l.startsWith('m=audio '));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('m='));
  if (end < 0) end = lines.length;
  for (let i = start; i < end; i++) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(lines[i]!);
    if (m) return { start, end, pt: m[1]! };
  }
  return null;
}

/**
 * The SDP with its voice section's lines replaced by what `edit` makes of them (given the section's Opus payload type).
 * Line endings and a trailing newline are kept as they were; an SDP without an Opus voice section is returned as is.
 */
export function rewriteVoice(sdp: string, edit: (body: string[], pt: string) => string[]): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const trailing = sdp.endsWith(eol);
  const lines = (trailing ? sdp.slice(0, -eol.length) : sdp).split(eol);
  const section = voiceSection(lines);
  if (!section) return sdp;
  const { start, end, pt } = section;
  const out = [...lines.slice(0, start), ...edit(lines.slice(start, end), pt), ...lines.slice(end)].join(eol);
  return trailing ? out + eol : out;
}

/** The section with `params` set on the fmtp line of payload type `pt`, added after its rtpmap when it has none. */
export function withFmtpParams(body: string[], pt: string, params: Record<string, string>): string[] {
  const fmtpPrefix = `a=fmtp:${pt} `;
  const out = [...body];
  const fmtpAt = out.findIndex((l) => l.startsWith(fmtpPrefix));
  const map = new Map<string, string>();
  if (fmtpAt >= 0) {
    for (const part of out[fmtpAt]!.slice(fmtpPrefix.length).split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) map.set(k, v.join('='));
    }
  }
  for (const [k, v] of Object.entries(params)) map.set(k, v);
  const fmtp = fmtpPrefix + [...map].map(([k, v]) => `${k}=${v}`).join(';');
  if (fmtpAt >= 0) out[fmtpAt] = fmtp;
  else out.splice(out.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `)) + 1, 0, fmtp);
  return out;
}

/** The SDP with its voice section asking for low bandwidth voice. Unchanged when it has no Opus voice section. */
export const lowVoiceSdp = (sdp: string): string =>
  rewriteVoice(sdp, (body, pt) => [...withFmtpParams(body.filter((l) => !l.startsWith('a=ptime:') && !l.startsWith('a=maxptime:')), pt, LOW_OPUS_PARAMS), `a=ptime:${LOW_VOICE_PTIME_MS}`]);

/** Does this description ask for low bandwidth voice (its voice section caps Opus at or below our rate)? For reports. */
export function asksLowVoice(sdp: string): boolean {
  const lines = sdp.split(/\r?\n/);
  const section = voiceSection(lines);
  if (!section) return false;
  const fmtp = lines.slice(section.start, section.end).find((l) => l.startsWith(`a=fmtp:${section.pt} `));
  const rate = fmtp && /(?:^|[; ])maxaveragebitrate=(\d+)/.exec(fmtp.slice(fmtp.indexOf(' ')));
  return !!rate && Number(rate[1]) <= LOW_VOICE_BPS;
}

/** How a round trip reads next to a friend's name: calm below LAG_WARN_MS, a warning up to LAG_BAD_MS, bad above. */
export const LAG_WARN_MS = 400;
export const LAG_BAD_MS = 1000;
export type LagLevel = 'ok' | 'warn' | 'bad';
export const lagLevel = (ms: number): LagLevel => (ms >= LAG_BAD_MS ? 'bad' : ms >= LAG_WARN_MS ? 'warn' : 'ok');
/** "84 ms" below a second, "1.2 s" up to ten, "14 s" above. */
export function formatDelay(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10} s`;
}
