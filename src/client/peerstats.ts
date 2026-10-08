import type { VideoFormat } from '../core/format';
import type { VoiceCounters, VoiceWindow } from '../core/voicequality';
import type { PeerDiagnostics } from './call';

/**
 * Reading a peer connection's WebRTC stats (client/call.ts): what the badge, the share tile and the voice buffer follow,
 * what a problem report keeps, what the watchdog and `voice_quality` send. Reads only; call.ts decides what to do.
 */

const pick = (r: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));

/**
 * What refreshStats follows every 2 s: bytes both ways, the formats, the share video's frames decoded (null: no count yet),
 * the round trip, and whether the selected pair is relayed (null: no pair yet).
 */
export type StatsSummary = {
  audioBytesIn: number; videoBytesIn: number; videoBytesOut: number; inFormat: VideoFormat | null; outFormat: VideoFormat | null; framesDecoded: number | null;
  rttMs: number | null; relayed: boolean | null;
};
export function summarise(st: RTCStatsReport): StatsSummary {
  let audioBytesIn = 0;
  let videoBytesIn = 0;
  let videoBytesOut = 0;
  let inFormat: VideoFormat | null = null;
  let outFormat: VideoFormat | null = null;
  let framesDecoded: number | null = null;
  /** RTCP's view of the round trip, from the receiver reports on what I send; seconds. */
  let rtcpRtt: number | undefined;
  type VideoRtp = { frameWidth?: number; frameHeight?: number; framesPerSecond?: number };
  const formatOf = (r: VideoRtp): VideoFormat | null => (r.frameWidth && r.frameHeight ? { width: r.frameWidth, height: r.frameHeight, fps: r.framesPerSecond ?? 0 } : null);
  st.forEach((r) => {
    if (r.type === 'inbound-rtp') {
      const rtp = r as RTCInboundRtpStreamStats & VideoRtp;
      if (rtp.kind === 'audio') audioBytesIn += rtp.bytesReceived ?? 0;
      if (rtp.kind === 'video') { videoBytesIn += rtp.bytesReceived ?? 0; inFormat = formatOf(rtp) ?? inFormat; framesDecoded = rtp.framesDecoded ?? framesDecoded; }
    } else if (r.type === 'outbound-rtp') {
      const rtp = r as RTCOutboundRtpStreamStats & VideoRtp;
      if (rtp.kind === 'video') { videoBytesOut += rtp.bytesSent ?? 0; outFormat = formatOf(rtp) ?? outFormat; }
    } else if (r.type === 'remote-inbound-rtp') {
      const rtt = (r as { roundTripTime?: number }).roundTripTime;
      if (rtt !== undefined) rtcpRtt = Math.max(rtcpRtt ?? 0, rtt);
    }
  });
  let pair: RTCIceCandidatePairStats | undefined;
  st.forEach((r) => { if (r.type === 'transport' && (r as RTCTransportStats).selectedCandidatePairId) pair = st.get((r as RTCTransportStats).selectedCandidatePairId!) as RTCIceCandidatePairStats; });
  if (!pair) st.forEach((r) => { if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).state === 'succeeded' && (r as RTCIceCandidatePairStats & { selected?: boolean }).selected) pair = r as RTCIceCandidatePairStats; });
  // A line that queues packets delays STUN checks and RTCP alike; the larger of the two is the honest one (ticket 27).
  const rtts = [(pair as RTCIceCandidatePairStats | undefined)?.currentRoundTripTime, rtcpRtt].filter((t): t is number => t !== undefined);
  const rttMs = rtts.length ? Math.round(Math.max(...rtts) * 1000) : null;
  let relayed: boolean | null = null;
  if (pair) {
    type CandidateStats = { candidateType?: string };
    const local = st.get((pair as RTCIceCandidatePairStats).localCandidateId) as CandidateStats | undefined;
    const remote = st.get((pair as RTCIceCandidatePairStats).remoteCandidateId) as CandidateStats | undefined;
    relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  }
  return { audioBytesIn, videoBytesIn, videoBytesOut, inFormat, outFormat, framesDecoded, rttMs, relayed };
}

/** The counters a problem report keeps (ticket 12): decoder and encoder, the selected pair, the voice both ways (ticket 27). */
export async function reportStats(pc: RTCPeerConnection, voiceTx: RTCRtpTransceiver | undefined): Promise<Pick<PeerDiagnostics, 'inboundVideo' | 'outboundVideo' | 'inboundVoice' | 'outboundVoice' | 'pair'>> {
  let inboundVideo: Record<string, unknown> | null = null;
  let outboundVideo: Record<string, unknown> | null = null;
  let inboundVoice: Record<string, unknown> | null = null;
  let outboundVoice: Record<string, unknown> | null = null;
  let pair: PeerDiagnostics['pair'] = null;
  try {
    const st = await pc.getStats();
    st.forEach((r) => {
      const rec = r as unknown as Record<string, unknown>;
      if (r.type === 'inbound-rtp' && rec['kind'] === 'video') {
        inboundVideo = pick(rec, ['bytesReceived', 'packetsReceived', 'packetsLost', 'framesReceived', 'framesDecoded', 'framesDropped', 'keyFramesDecoded', 'framesPerSecond', 'frameWidth', 'frameHeight', 'pliCount', 'firCount', 'nackCount', 'freezeCount', 'totalFreezesDuration', 'pauseCount', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'decoderImplementation', 'powerEfficientDecoder', 'lastPacketReceivedTimestamp']);
        const codec = rec['codecId'] ? (st.get(rec['codecId'] as string) as unknown as Record<string, unknown> | undefined) : undefined;
        if (codec) inboundVideo['codec'] = codec['mimeType'];
      } else if (r.type === 'outbound-rtp' && rec['kind'] === 'video') {
        outboundVideo = pick(rec, ['bytesSent', 'packetsSent', 'framesEncoded', 'keyFramesEncoded', 'framesSent', 'framesPerSecond', 'frameWidth', 'frameHeight', 'qualityLimitationReason', 'qualityLimitationDurations', 'encoderImplementation', 'targetBitrate', 'pliCount', 'firCount', 'nackCount', 'active']);
      } else if (r.type === 'transport' && (r as RTCTransportStats).selectedCandidatePairId) {
        const cp = st.get((r as RTCTransportStats).selectedCandidatePairId!) as RTCIceCandidatePairStats | undefined;
        if (cp) {
          const local = st.get(cp.localCandidateId) as unknown as Record<string, unknown> | undefined;
          const remote = st.get(cp.remoteCandidateId) as unknown as Record<string, unknown> | undefined;
          pair = {
            local: String(local?.['candidateType'] ?? '?'), remote: String(remote?.['candidateType'] ?? '?'), state: cp.state,
            rttMs: cp.currentRoundTripTime !== undefined ? Math.round(cp.currentRoundTripTime * 1000) : null,
            outgoingKbps: cp.availableOutgoingBitrate !== undefined ? Math.round(cp.availableOutgoingBitrate / 1000) : null,
          };
        }
      }
    });
    // The voice slot's own stats: a connection carries a second audio stream, the share's.
    if (voiceTx) {
      const codecOf = (st: RTCStatsReport, rec: Record<string, unknown>) => {
        const codec = rec['codecId'] ? (st.get(rec['codecId'] as string) as unknown as Record<string, unknown> | undefined) : undefined;
        return codec ? { codec: codec['mimeType'], fmtp: codec['sdpFmtpLine'] } : {};
      };
      const rx = await voiceTx.receiver.getStats();
      rx.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        if (r.type === 'inbound-rtp') inboundVoice = { ...pick(rec, ['bytesReceived', 'packetsReceived', 'packetsLost', 'packetsDiscarded', 'jitter', 'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferEmittedCount', 'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'fecPacketsReceived', 'fecPacketsDiscarded', 'totalAudioEnergy', 'lastPacketReceivedTimestamp']), ...codecOf(rx, rec) };
      });
      const tx = await voiceTx.sender.getStats();
      tx.forEach((r) => {
        const rec = r as unknown as Record<string, unknown>;
        if (r.type === 'outbound-rtp') outboundVoice = { ...outboundVoice, ...pick(rec, ['bytesSent', 'packetsSent', 'targetBitrate', 'retransmittedPacketsSent', 'active']), ...codecOf(tx, rec) };
        else if (r.type === 'remote-inbound-rtp') outboundVoice = { ...outboundVoice, remote: pick(rec, ['packetsLost', 'fractionLost', 'jitter', 'roundTripTime', 'totalRoundTripTime', 'roundTripTimeMeasurements']) };
      });
    }
  } catch { /* connection closed meanwhile */ }
  return { inboundVideo, outboundVideo, inboundVoice, outboundVoice, pair };
}

const VOICE_COUNTER_KEYS = ['packetsReceived', 'packetsLost', 'bytesReceived', 'jitter', 'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'fecPacketsReceived'];
/** The voice receiver's cumulative counters (ticket 34), or null before their voice arrives or once the connection is closed. */
export async function voiceCounters(receiver: RTCRtpReceiver): Promise<VoiceCounters | null> {
  let out: VoiceCounters | null = null;
  try {
    (await receiver.getStats()).forEach((r) => { if (r.type === 'inbound-rtp') out = { at: Date.now(), ...(pick(r as unknown as Record<string, unknown>, VOICE_COUNTER_KEYS) as Partial<VoiceCounters>) }; });
  } catch { /* closed meanwhile */ }
  return out;
}

/** A voice window as PostHog event properties. */
export const windowProps = (w: VoiceWindow) => ({ seconds: w.seconds, packets: w.packets, lost_pct: w.lostPct, concealed_pct: w.concealedPct, concealment_events: w.concealmentEvents, jitter_ms: w.jitterMs, buffer_ms: w.bufferMs, decel_pct: w.decelPct, accel_pct: w.accelPct, fec_packets: w.fecPackets, bytes_per_packet: w.bytesPerPacket });

/** Candidates gathered and received so far, for `peer_connecting_slow` (spec §8.2). */
export async function candidateCounts(pc: RTCPeerConnection): Promise<{ candidates_local: number; candidates_remote: number; candidates_relay: number }> {
  const counts = { candidates_local: 0, candidates_remote: 0, candidates_relay: 0 };
  try {
    (await pc.getStats()).forEach((r) => {
      if (r.type === 'local-candidate') { counts.candidates_local++; if ((r as { candidateType?: string }).candidateType === 'relay') counts.candidates_relay++; }
      else if (r.type === 'remote-candidate') counts.candidates_remote++;
    });
  } catch { /* closed meanwhile */ }
  return counts;
}
