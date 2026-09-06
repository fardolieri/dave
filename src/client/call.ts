import { createEffect, createSignal, onCleanup } from 'solid-js';
import {
  ICE_DISCONNECTED_GRACE_MS, ICE_REFRESH_AFTER_MS, ICE_RESTART_BACKOFF_MS, PEER_GRACE_MS, SLOT_INDEX, initiatesTo, isPolite, perViewerBitrate,
} from '../core/mesh';
import type { IceServer, Person, ServerMessage, SignalData } from '../core/protocol';
import type { createRoom } from './room';
import { local } from './storage';

export type ConnState = 'connecting' | 'direct' | 'relayed' | 'reconnecting' | 'unreachable';

/** What the UI shows per remote participant. Plain data mirrored from WebRTC events (spec §2.1). */
export type PeerView = {
  publicKey: string; name: string; conn: ConnState; speaking: boolean; serverLost: boolean; audioBytesIn: number;
  /** Their share as I see it: whether I asked for it, whether frames have arrived, and the inbound rate. */
  watching: boolean; shareLive: boolean; shareKbps: number;
};

type Peer = {
  key: string;
  name: string;
  pc: RTCPeerConnection;
  polite: boolean;
  tx: RTCRtpTransceiver[];
  makingOffer: boolean;
  ignoreOffer: boolean;
  srdAnswerPending: boolean;
  audio: HTMLAudioElement;
  analyser?: AnalyserNode;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  restarts: number;
  graceTimer?: ReturnType<typeof setTimeout>;
  view: PeerView;
  /** They asked to receive my share. */
  subscribedToMe: boolean;
  remoteShare: MediaStream;
  videoBytesIn: number;
  videoBytesAt: number;
};

const SPEAK_THRESHOLD = 0.02;
const SPEAK_HOLD_MS = 300;

/**
 * The Call from this browser's point of view (ADR 0001): one RTCPeerConnection per other
 * participant, three fixed transceivers, perfect negotiation with polite = lower key,
 * newcomer initiates, all control over the room socket. Voice only for now; shares come with ticket 05.
 */
export function createCall(room: ReturnType<typeof createRoom>, myKey: string) {
  const [inCall, setInCall] = createSignal(false);
  const [muted, setMutedSignal] = createSignal(local.get('muted') === 'true');
  const [views, setViews] = createSignal<PeerView[]>([]);
  const [speakingSelf, setSpeakingSelf] = createSignal(false);
  const [joinError, setJoinError] = createSignal<string | null>(null);
  const [sharing, setSharing] = createSignal<MediaStream | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);
  let shareVideo: MediaStreamTrack | null = null;
  let shareAudio: MediaStreamTrack | null = null;

  const peers = new Map<string, Peer>();
  let localStream: MediaStream | null = null;
  let voiceTrack: MediaStreamTrack | null = null;
  let iceServers: IceServer[] = [];
  let iceIssuedAt = 0;
  let myJoinSeq: number | null = null;
  let audioCtx: AudioContext | null = null;
  let localAnalyser: AnalyserNode | null = null;
  const pending = new Map<'call' | 'ice', (m: ServerMessage) => void>();
  /** Send a request and wait for the one reply type that answers it, or null on timeout. */
  function awaitReply<K extends 'call' | 'ice'>(kind: K, request: () => void, timeoutMs: number): Promise<Extract<ServerMessage, { t: K }> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(kind); resolve(null); }, timeoutMs);
      pending.set(kind, (m) => { clearTimeout(timer); pending.delete(kind); resolve(m as Extract<ServerMessage, { t: K }>); });
      request();
    });
  }
  const sources = new Map<string, MediaStreamAudioSourceNode>();

  const me = (): Person | null => room.people().find((p) => p.publicKey === myKey) ?? null;
  const publish = () => setViews([...peers.values()].map((p) => ({ ...p.view })));
  const setView = (p: Peer, patch: Partial<PeerView>) => { Object.assign(p.view, patch); publish(); };

  // ---- media
  async function openMicrophone(): Promise<void> {
    if (voiceTrack) return;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    voiceTrack = localStream.getAudioTracks()[0] ?? null;
    if (voiceTrack) voiceTrack.enabled = !muted();
    audioCtx ??= new AudioContext();
    localAnalyser = analyserFor('me', localStream);
  }
  function analyserFor(key: string, stream: MediaStream): AnalyserNode {
    const ctx = audioCtx!;
    sources.get(key)?.disconnect();
    const src = ctx.createMediaStreamSource(stream);
    sources.set(key, src);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    return an;
  }
  const levelOf = (an: AnalyserNode): number => {
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  };
  const lastLoud = new Map<string, number>();
  const speakingTimer = setInterval(() => {
    if (!audioCtx) return;
    const now = Date.now();
    const loud = (key: string, an: AnalyserNode | null | undefined, gate: boolean) => {
      if (an && gate && levelOf(an) > SPEAK_THRESHOLD) lastLoud.set(key, now);
      return now - (lastLoud.get(key) ?? 0) < SPEAK_HOLD_MS;
    };
    setSpeakingSelf(loud('me', localAnalyser, !muted()));
    let changed = false;
    for (const p of peers.values()) {
      const s = loud(p.key, p.analyser, true);
      if (s !== p.view.speaking) { p.view.speaking = s; changed = true; }
    }
    if (changed) publish();
  }, 100);

  // ---- peers
  function createPeer(key: string, name: string, initiator: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = {
      key, name, pc, polite: isPolite(myKey, key), tx: [], makingOffer: false, ignoreOffer: false, srdAnswerPending: false, audio, restarts: 0,
      view: { publicKey: key, name, conn: 'connecting', speaking: false, serverLost: false, audioBytesIn: 0, watching: false, shareLive: false, shareKbps: 0 },
      subscribedToMe: false, remoteShare: new MediaStream(), videoBytesIn: 0, videoBytesAt: 0,
    };
    if (initiator) {
      // Only the offering side pre-adds transceivers (ADR 0001, spike finding).
      peer.tx = [pc.addTransceiver('audio', { direction: 'sendrecv' }), pc.addTransceiver('video', { direction: 'sendrecv' }), pc.addTransceiver('audio', { direction: 'sendrecv' })];
      attachLocalTracks(peer);
    }
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        room.send({ t: 'signal', to: key, data: { description: pc.localDescription } });
      } catch (e) {
        console.warn('negotiationneeded failed', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => room.send({ t: 'signal', to: key, data: { candidate } });
    pc.oniceconnectionstatechange = () => onIceState(peer);
    pc.ontrack = ({ track, transceiver }) => {
      // Fires inside setRemoteDescription, before the answerer has recorded its transceivers,
      // so identify the slot by position in the connection's transceiver list, not via peer.tx.
      const slot = pc.getTransceivers().indexOf(transceiver);
      if (track.kind === 'audio' && slot === SLOT_INDEX.voice) {
        const stream = new MediaStream([track]);
        audio.srcObject = stream;
        audio.play().catch(() => { /* needs a gesture on some browsers; the join click normally suffices */ });
        if (audioCtx) peer.analyser = analyserFor(key, stream);
      } else if (slot === SLOT_INDEX.shareVideo || slot === SLOT_INDEX.shareAudio) {
        // Share tracks exist from join time, muted and empty until the sharer sends. "Live" follows the
        // unmute/mute events, which is how a viewer knows frames are actually arriving (spec §6.5).
        peer.remoteShare.addTrack(track);
        if (slot === SLOT_INDEX.shareVideo) {
          track.onunmute = () => setView(peer, { shareLive: true });
          track.onmute = () => setView(peer, { shareLive: false, shareKbps: 0 });
        }
      }
    };
    peers.set(key, peer);
    publish();
    return peer;
  }

  function attachLocalTracks(peer: Peer): void {
    const voiceSender = peer.tx[SLOT_INDEX.voice]?.sender;
    if (voiceSender && voiceTrack) voiceSender.replaceTrack(voiceTrack).catch((e) => console.warn('replaceTrack voice', e));
    if (shareVideo) {
      // A share flows to nobody until they subscribe: deactivate right after attaching (waits for the answer).
      peer.tx[SLOT_INDEX.shareVideo]?.sender.replaceTrack(shareVideo).then(() => applyShareEncoding(peer)).catch((e) => console.warn('replaceTrack share video', e));
      if (shareAudio) peer.tx[SLOT_INDEX.shareAudio]?.sender.replaceTrack(shareAudio).catch((e) => console.warn('replaceTrack share audio', e));
    }
  }

  /** Sender-side toggle for one viewer: active follows their subscription, bitrate follows the budget rule (spec §6.4). Retries until the answer has produced encodings. */
  async function applyShareEncoding(peer: Peer, attempt = 0): Promise<void> {
    if (!shareVideo || peer.pc.connectionState === 'closed') return;
    const viewers = [...peers.values()].filter((p) => p.subscribedToMe).length;
    for (const slot of [SLOT_INDEX.shareVideo, SLOT_INDEX.shareAudio]) {
      const sender = peer.tx[slot]?.sender;
      if (!sender?.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) {
        if (attempt < 30) setTimeout(() => void applyShareEncoding(peer, attempt + 1), 100);
        return;
      }
      params.encodings[0]!.active = peer.subscribedToMe;
      if (slot === SLOT_INDEX.shareVideo) params.encodings[0]!.maxBitrate = perViewerBitrate(viewers);
      try {
        await sender.setParameters(params);
      } catch (e) {
        console.warn('setParameters share', e);
      }
    }
  }

  /** Re-apply the budget split to every current viewer when the viewer set changes. */
  function reapplyShareEncodings(): void {
    for (const p of peers.values()) if (p.subscribedToMe) void applyShareEncoding(p);
  }

  async function onSignal(from: string, data: SignalData): Promise<void> {
    if (!inCall()) return;
    let peer = peers.get(from);
    const isOffer = (data.description as RTCSessionDescriptionInit | undefined)?.type === 'offer';
    if (peer && isOffer && (peer.view.serverLost || peer.pc.iceConnectionState === 'failed' || peer.pc.connectionState === 'closed')) {
      // A fresh offer from a peer whose old connection is dead or who vanished and came back: start over.
      closePeer(from);
      peer = undefined;
    }
    if (!peer) {
      const person = room.people().find((p) => p.publicKey === from);
      if (!person || person.role !== 'participant') return;
      peer = createPeer(from, person.name, false);
    }
    const { pc } = peer;
    try {
      if (data.description) {
        const description = data.description as RTCSessionDescriptionInit;
        const collision = description.type === 'offer' && (peer.makingOffer || (pc.signalingState !== 'stable' && !peer.srdAnswerPending));
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        peer.srdAnswerPending = description.type === 'answer';
        await pc.setRemoteDescription(description);
        peer.srdAnswerPending = false;
        if (description.type === 'offer') {
          if (peer.tx.length === 0) {
            // The answerer adopts the offered transceivers and makes them bidirectional before answering.
            peer.tx = pc.getTransceivers().slice(0, 3);
            for (const t of peer.tx) t.direction = 'sendrecv';
            attachLocalTracks(peer);
          }
          await pc.setLocalDescription();
          room.send({ t: 'signal', to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate !== undefined) {
        try {
          await pc.addIceCandidate((data.candidate as RTCIceCandidateInit | null) ?? undefined);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn('signal handling failed', e);
    }
  }

  function onIceState(peer: Peer): void {
    const s = peer.pc.iceConnectionState;
    clearTimeout(peer.disconnectTimer);
    if (s === 'connected' || s === 'completed') {
      peer.restarts = 0;
      clearTimeout(peer.restartTimer);
      if (peer.view.conn === 'connecting' || peer.view.conn === 'reconnecting' || peer.view.conn === 'unreachable') setView(peer, { conn: 'direct' });
      void refreshStats(peer);
    } else if (s === 'disconnected') {
      setView(peer, { conn: 'reconnecting' });
      peer.disconnectTimer = setTimeout(() => { if (peer.pc.iceConnectionState === 'disconnected') void restartIce(peer); }, ICE_DISCONNECTED_GRACE_MS);
    } else if (s === 'failed') {
      setView(peer, { conn: 'unreachable' });
      const delay = ICE_RESTART_BACKOFF_MS[Math.min(peer.restarts, ICE_RESTART_BACKOFF_MS.length - 1)]!;
      peer.restarts++;
      peer.restartTimer = setTimeout(() => void restartIce(peer), delay);
    } else if (s === 'closed') {
      setView(peer, { conn: 'unreachable' });
    }
  }

  async function restartIce(peer: Peer): Promise<void> {
    if (peer.pc.connectionState === 'closed') return;
    if (Date.now() - iceIssuedAt > ICE_REFRESH_AFTER_MS) {
      const fresh = await requestIce();
      if (fresh) { iceServers = fresh.iceServers; iceIssuedAt = fresh.issuedAt; peer.pc.setConfiguration({ iceServers }); }
    }
    peer.pc.restartIce();
  }

  const requestIce = () => awaitReply('ice', () => room.send({ t: 'ice' }), 5000);

  async function refreshStats(peer: Peer): Promise<void> {
    if (peer.pc.connectionState === 'closed') return;
    const st = await peer.pc.getStats();
    let audioBytesIn = 0;
    let videoBytesIn = 0;
    st.forEach((r) => {
      if (r.type !== 'inbound-rtp') return;
      const rtp = r as RTCInboundRtpStreamStats;
      if (rtp.kind === 'audio') audioBytesIn += rtp.bytesReceived ?? 0;
      if (rtp.kind === 'video') videoBytesIn += rtp.bytesReceived ?? 0;
    });
    if (audioBytesIn !== peer.view.audioBytesIn) peer.view.audioBytesIn = audioBytesIn;
    const now = Date.now();
    if (peer.videoBytesAt) {
      const kbps = Math.round(((videoBytesIn - peer.videoBytesIn) * 8) / Math.max(1, now - peer.videoBytesAt));
      if (kbps !== peer.view.shareKbps && peer.view.shareLive) setView(peer, { shareKbps: kbps });
    }
    peer.videoBytesIn = videoBytesIn;
    peer.videoBytesAt = now;
    let pair: RTCIceCandidatePairStats | undefined;
    st.forEach((r) => { if (r.type === 'transport' && (r as RTCTransportStats).selectedCandidatePairId) pair = st.get((r as RTCTransportStats).selectedCandidatePairId!) as RTCIceCandidatePairStats; });
    if (!pair) st.forEach((r) => { if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).state === 'succeeded' && (r as RTCIceCandidatePairStats & { selected?: boolean }).selected) pair = r as RTCIceCandidatePairStats; });
    if (!pair) return;
    type CandidateStats = { candidateType?: string };
    const local = st.get(pair.localCandidateId) as CandidateStats | undefined;
    const remote = st.get(pair.remoteCandidateId) as CandidateStats | undefined;
    const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    const ice = peer.pc.iceConnectionState;
    if ((ice === 'connected' || ice === 'completed') && peer.view.conn !== (relayed ? 'relayed' : 'direct')) setView(peer, { conn: relayed ? 'relayed' : 'direct' });
  }
  const statsTimer = setInterval(() => { for (const p of peers.values()) void refreshStats(p); }, 2000);

  function closePeer(key: string): void {
    const peer = peers.get(key);
    if (!peer) return;
    clearTimeout(peer.disconnectTimer); clearTimeout(peer.restartTimer); clearTimeout(peer.graceTimer);
    peer.pc.close();
    peer.audio.srcObject = null;
    sources.get(key)?.disconnect();
    sources.delete(key);
    peers.delete(key);
    lastLoud.delete(key);
    publish();
  }

  /** Server presence is authoritative for membership; media follows it (spec §8.2). */
  function reconcile(people: Person[]): void {
    const self = people.find((p) => p.publicKey === myKey);
    if (!inCall() || !self || self.role !== 'participant') return;
    for (const p of people) {
      if (p.publicKey === myKey || p.role !== 'participant') continue;
      const existing = peers.get(p.publicKey);
      if (existing) {
        if (existing.view.serverLost) { clearTimeout(existing.graceTimer); setView(existing, { serverLost: false, name: p.name }); }
        continue;
      }
      if (initiatesTo({ ...self, joinSeq: myJoinSeq }, p)) createPeer(p.publicKey, p.name, true);
    }
    for (const peer of peers.values()) {
      const person = people.find((p) => p.publicKey === peer.key);
      if (person && person.role === 'participant') continue;
      // Vanished, or reappeared as a visitor while their rejoin is still in flight: their server socket dropped.
      // A deliberate leave arrives as an explicit `left` and closes at once; here we keep media for a grace period.
      if (!peer.view.serverLost) {
        setView(peer, { serverLost: true });
        peer.graceTimer = setTimeout(() => closePeer(peer.key), PEER_GRACE_MS);
      }
    }
  }
  createEffect(() => room.people(), (people) => reconcile(people));

  // Re-declare after our own server reconnect (spec §8.1): peer connections stay, join sequence is fresh.
  createEffect(() => room.status().kind, (kind, prev) => {
    if (kind === 'connected' && prev !== undefined && prev !== 'connected' && inCall()) void rejoinAfterReconnect();
  });

  async function rejoinAfterReconnect(): Promise<void> {
    const reply = await declareJoin();
    if (!reply) return;
    // Peers that kept their connection to us stay. Any connection that died while we were away is
    // rebuilt: we now hold the highest join sequence, so dropping it makes reconcile re-initiate.
    for (const peer of [...peers.values()]) {
      const s = peer.pc.iceConnectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') closePeer(peer.key);
    }
    reconcile(room.people());
  }

  async function declareJoin(): Promise<Extract<ServerMessage, { t: 'call' }> | null> {
    const m = await awaitReply('call', () => room.send({ t: 'join', muted: muted() }), 8000);
    if (m) { myJoinSeq = m.joinSeq; iceServers = m.iceServers; iceIssuedAt = m.issuedAt; }
    return m;
  }

  const unsubscribe = room.subscribe((m) => {
    switch (m.t) {
      case 'call': pending.get('call')?.(m); return;
      case 'ice': pending.get('ice')?.(m); return;
      case 'signal': void onSignal(m.from, m.data); return;
      case 'left': closePeer(m.publicKey); return;
      case 'subscribe': {
        const peer = peers.get(m.from);
        if (!peer) return;
        peer.subscribedToMe = m.on;
        reapplyShareEncodings();
        if (!m.on) void applyShareEncoding(peer); // the one leaving must be deactivated too
        return;
      }
    }
  });

  // ---- shares (spec §6.2, §6.5)
  async function startShare(): Promise<void> {
    if (!inCall() || shareVideo) return;
    setShareError(null);
    let stream: MediaStream;
    try {
      const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: true,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      };
      stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (e) {
      if (!(e instanceof Error && e.name === 'NotAllowedError')) setShareError(`Could not start sharing: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    shareVideo = stream.getVideoTracks()[0] ?? null;
    shareAudio = stream.getAudioTracks()[0] ?? null;
    if (!shareVideo) return;
    shareVideo.contentHint = 'detail';
    shareVideo.onended = () => void stopShare(); // the browser's own "stop sharing" control
    for (const peer of peers.values()) attachLocalTracks(peer);
    setSharing(stream);
    room.send({ t: 'share', on: true });
  }

  async function stopShare(): Promise<void> {
    if (!shareVideo) return;
    shareVideo.stop();
    shareAudio?.stop();
    shareVideo = null;
    shareAudio = null;
    for (const peer of peers.values()) {
      peer.subscribedToMe = false;
      await peer.tx[SLOT_INDEX.shareVideo]?.sender.replaceTrack(null).catch(() => {});
      await peer.tx[SLOT_INDEX.shareAudio]?.sender.replaceTrack(null).catch(() => {});
    }
    setSharing(null);
    room.send({ t: 'share', on: false });
  }

  /** Viewer side: ask the sharer to start or stop sending me their share. */
  function watch(key: string, on: boolean): void {
    const peer = peers.get(key);
    if (!peer || peer.view.watching === on) return;
    setView(peer, { watching: on, shareKbps: 0 });
    room.send({ t: 'subscribe', to: key, on });
  }

  /** Fullscreen on one share unsubscribes every other (spec §6.5); leaving fullscreen does nothing. */
  function watchOnly(key: string): void {
    for (const p of peers.values()) if (p.key !== key && p.view.watching) watch(p.key, false);
  }

  const shareStreamOf = (key: string): MediaStream | undefined => peers.get(key)?.remoteShare;

  // ---- actions
  let joining = false;
  async function join(): Promise<void> {
    if (inCall() || joining) return;
    joining = true;
    setJoinError(null);
    try {
      try {
        await openMicrophone();
      } catch (e) {
        setJoinError(e instanceof Error && e.name === 'NotAllowedError' ? 'Microphone access was denied.' : `Could not open the microphone: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const reply = await declareJoin();
      if (!reply) { setJoinError('The server did not answer the join request.'); return; }
      setInCall(true);
      reconcile(room.people());
    } finally {
      joining = false;
    }
  }

  function leave(): void {
    if (!inCall()) return;
    void stopShare();
    room.send({ t: 'leave' });
    for (const key of [...peers.keys()]) closePeer(key);
    setInCall(false);
    myJoinSeq = null;
    voiceTrack?.stop();
    localStream?.getTracks().forEach((t) => t.stop());
    sources.get('me')?.disconnect(); sources.delete('me');
    voiceTrack = null; localStream = null; localAnalyser = null;
    setSpeakingSelf(false);
  }

  function setMuted(m: boolean): void {
    setMutedSignal(m);
    local.set('muted', String(m));
    if (voiceTrack) voiceTrack.enabled = !m;
    if (inCall()) room.send({ t: 'mute', muted: m });
  }

  onCleanup(() => {
    unsubscribe();
    clearInterval(statsTimer);
    clearInterval(speakingTimer);
    leave();
    audioCtx?.close();
  });

  if (import.meta.env.DEV) {
    // Dev aid for scripts/drive.mjs: inspect the mesh from the DevTools protocol. Absent in production builds.
    (window as unknown as { __dave?: unknown }).__dave = {
      peers: () => [...peers.values()].map((p) => ({ name: p.name, ice: p.pc.iceConnectionState, conn: p.view.conn, audioBytesIn: p.view.audioBytesIn, videoBytesIn: p.videoBytesIn, watching: p.view.watching, shareLive: p.view.shareLive, subscribedToMe: p.subscribedToMe, transceivers: p.pc.getTransceivers().length })),
    };
  }

  return { inCall, muted, views, speakingSelf, joinError, join, leave, setMuted, myJoinSeq: () => myJoinSeq, sharing, shareError, startShare, stopShare, watch, watchOnly, shareStreamOf };
}
