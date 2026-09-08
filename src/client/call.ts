import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { distinctFormats, type VideoFormat } from '../core/format';
import { stuckDelay } from '../core/mesh';
import posthog from './posthog';
import {
  ICE_DISCONNECTED_GRACE_MS, ICE_REFRESH_AFTER_MS, ICE_RESTART_BACKOFF_MS, PEER_GRACE_MS, SLOT_INDEX, initiatesTo, isPolite,
} from '../core/mesh';
import type { IceServer, Person, ServerMessage, SignalData } from '../core/protocol';
import {
  SMALL_SCREEN_QUERY, applyPreset, clampVolume, contentHint, parseAudioSettings, parseShareSettings, parseViewerSettings, parseVolumes, shareEncoding, trackConstraints, withChange,
  type AudioSettings, type PresetName, type ShareSettings, type ViewerSettings,
} from '../core/settings';
import type { createRoom } from './room';
import { local } from './storage';

export type ConnState = 'connecting' | 'direct' | 'relayed' | 'reconnecting' | 'unreachable';

/** My own share as the sharer sees it: total upload, the distinct encoded formats, how many watch. */
export type OutgoingShare = { kbps: number; formats: VideoFormat[]; viewers: number };

/** Snapshot for problem reports (ticket 12): states and counters, no names, no message texts. */
export type PeerDiagnostics = {
  fingerprint: string | null; polite: boolean; restarts: number; viewsMyShare: boolean; viewerScale: number;
  view: Pick<PeerView, 'conn' | 'watching' | 'shareLive' | 'shareKbps' | 'shareFormat' | 'serverLost' | 'volume'>;
  pc: { connection: RTCPeerConnectionState; ice: RTCIceConnectionState; signaling: RTCSignalingState; gathering: RTCIceGatheringState; transceivers: number };
  shareTrack: { readyState: string; muted: boolean } | null;
  inboundVideo: Record<string, unknown> | null;
  outboundVideo: Record<string, unknown> | null;
  pair: { local: string; remote: string; state: string } | null;
};
export type CallDiagnostics = {
  inCall: boolean; muted: boolean; joinSeq: number | null; sharing: Record<string, unknown> | null; outgoing: OutgoingShare | null;
  shareSettings: unknown; viewerSettings: unknown; audioProcessing: unknown; ice: { servers: number; turn: boolean; ageMinutes: number | null };
  peers: PeerDiagnostics[];
};
const sameFormat = (a: VideoFormat | null, b: VideoFormat | null): boolean => a === b || (!!a && !!b && a.width === b.width && a.height === b.height && Math.round(a.fps) === Math.round(b.fps));

/** What the UI shows per remote participant. Plain data mirrored from WebRTC events (spec §2.1). */
export type PeerView = {
  publicKey: string; name: string; conn: ConnState; speaking: boolean; serverLost: boolean; audioBytesIn: number;
  /** Their share as I see it: whether I asked for it, whether frames have arrived, the inbound rate and format. */
  watching: boolean; shareLive: boolean; shareKbps: number; shareFormat: VideoFormat | null;
  /** How loud this participant is for me, 0 to 1. Local only. */
  volume: number;
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
  /** Plays the gain-adjusted voice; sink-selectable. */
  audio: HTMLAudioElement;
  /** Chrome only feeds a remote track into WebAudio while some media element plays it, so the raw track stays attached here, muted. */
  keepAlive: HTMLAudioElement;
  analyser?: AnalyserNode;
  voiceGain?: GainNode;
  shareGain?: GainNode;
  audioNodes: AudioNode[];
  disconnectTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  restarts: number;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Fires if the connection never leaves "connecting" (see connectWatchdog). */
  connectTimer?: ReturnType<typeof setTimeout>;
  view: PeerView;
  /** They asked to receive my share (they are a Viewer of it). */
  viewsMyShare: boolean;
  remoteShare: MediaStream;
  shareAudio: HTMLAudioElement;
  videoBytesIn: number;
  videoBytesAt: number;
  /** My share as sent to this peer: bytes so far, rate and encoded format from the last stats read. */
  videoBytesOut: number;
  outKbps: number;
  outFormat: VideoFormat | null;
  /** Serialises setParameters calls on this connection so a late subscribe cannot collide with an earlier one. */
  encodingChain: Promise<void>;
  /** Downscale this Viewer asked for (small screen), 1 = none. */
  viewerScale: number;
  /** Outgoing ICE candidates are batched for a moment to cut message count (each is a relay request). */
  outgoingCandidates: unknown[];
  candidateTimer?: ReturnType<typeof setTimeout>;
};
const CANDIDATE_BATCH_MS = 60;

const SPEAK_THRESHOLD = 0.02;
const SPEAK_HOLD_MS = 300;

/**
 * The Call from this browser's point of view (ADR 0001): one RTCPeerConnection per other
 * participant, three fixed transceivers, perfect negotiation with polite = lower key,
 * newcomer initiates, all control over the room socket. Voice and one Share per participant.
 */
export function createCall(room: ReturnType<typeof createRoom>, myKey: string) {
  const [inCall, setInCallSignal] = createSignal(false);
  // Solid 2 stages signal writes to a microtask, so code that runs right after a write still reads the old
  // value. Internal logic therefore uses this plain mirror; the signal is for rendering only.
  let joined = false;
  const setInCall = (v: boolean) => { joined = v; setInCallSignal(v); };
  const [muted, setMutedSignal] = createSignal(local.get('muted') === 'true');
  const [views, setViews] = createSignal<PeerView[]>([]);
  const [speakingSelf, setSpeakingSelf] = createSignal(false);
  const [joinError, setJoinError] = createSignal<string | null>(null);
  const [sharing, setSharing] = createSignal<MediaStream | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);
  /** Remote share streams by participant key, as a signal so tiles re-read them when a connection is rebuilt. */
  const [shareStreams, setShareStreams] = createSignal<Map<string, MediaStream>>(new Map());
  let shareVideo: MediaStreamTrack | null = null;
  let shareAudio: MediaStreamTrack | null = null;
  /** What my share currently costs and looks like across all viewers (spec §6.5); null while not sharing. */
  const [outgoing, setOutgoing] = createSignal<OutgoingShare | null>(null);
  /** Subscribe requests that arrived before the connection to that participant existed. */
  const earlyViewers = new Map<string, number>();

  // ---- settings (spec §6.1, §6.3), remembered per browser
  /** A setting signal that also persists: [read, write]. */
  function persisted<T extends object>(key: string, parse: (raw: string | null) => T): [() => T, (next: T) => void] {
    const [get, set] = createSignal<T>(parse(local.get(key)) as Exclude<T, Function>);
    return [get, (next) => { set(() => next); local.set(key, JSON.stringify(next)); }];
  }
  const [shareSettings, storeShareSettings] = persisted('shareSettings', parseShareSettings);
  /** Local volume per participant public key, remembered per browser. */
  const [volumes, storeVolumes] = persisted('volumes', parseVolumes);
  const [audioSettings, storeAudioSettings] = persisted('audioSettings', parseAudioSettings);
  const [viewerSettings, storeViewerSettings] = persisted('viewerSettings', parseViewerSettings);
  const [devices, setDevices] = createSignal<{ microphones: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }>({ microphones: [], speakers: [] });
  const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const smallScreen = () => typeof matchMedia !== 'undefined' && matchMedia(SMALL_SCREEN_QUERY).matches;

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
  const setView = (p: Peer, patch: Partial<PeerView>) => {
    if (patch.conn && patch.conn !== p.view.conn) posthog.capture('peer_connection_state', { state: patch.conn, previous: p.view.conn, peers: peers.size });
    Object.assign(p.view, patch);
    publish();
  };

  // ---- media
  function microphoneConstraints(): MediaTrackConstraints {
    const a = audioSettings();
    const c: MediaTrackConstraints = { echoCancellation: a.echoCancellation, noiseSuppression: a.noiseSuppression, autoGainControl: a.autoGainControl };
    // `ideal`, not `exact`: a remembered microphone that is unplugged must not lock anyone out of the call.
    if (a.microphoneId) c.deviceId = { ideal: a.microphoneId };
    return c;
  }
  async function openMicrophone(): Promise<void> {
    if (voiceTrack) return;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
    voiceTrack = localStream.getAudioTracks()[0] ?? null;
    if (voiceTrack) voiceTrack.enabled = !muted();
    audioCtx ??= new AudioContext();
    localAnalyser = analyserFor('me', localStream);
    void refreshDevices();
  }
  async function refreshDevices(): Promise<void> {
    try {
      // Chrome lists pseudo-devices "default" (and "communications" on Windows) that mirror a real entry;
      // the panel's own "Default" option already means the browser default, so drop them.
      const real = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
      setDevices({ microphones: real.filter((d) => d.kind === 'audioinput'), speakers: real.filter((d) => d.kind === 'audiooutput') });
    } catch { /* enumeration unavailable */ }
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

  async function applySink(el: HTMLMediaElement): Promise<void> {
    const id = untrack(audioSettings).speakerId; // a snapshot: sinks are re-applied explicitly when the setting changes
    if (!canPickSpeaker) return;
    try { await (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(id); } catch { /* device gone: browser default */ }
  }
  /** Firefox exposes output devices through a picker rather than enumeration. Chrome lists them instead. */
  const canPickSpeakerDialog = typeof navigator !== 'undefined' && typeof (navigator.mediaDevices as MediaDevices & { selectAudioOutput?: unknown })?.selectAudioOutput === 'function';
  async function pickSpeaker(): Promise<void> {
    const md = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
    if (!md.selectAudioOutput) return;
    try {
      const device = await md.selectAudioOutput();
      await changeAudio({ speakerId: device.deviceId });
      void refreshDevices();
    } catch { /* dismissed */ }
  }

  function applyJitterTarget(receiver: RTCRtpReceiver): void {
    const ms = untrack(viewerSettings).jitterBufferTargetMs; // a snapshot: receivers are re-applied explicitly on change
    try { (receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = ms > 0 ? ms : null; } catch { /* unsupported */ }
  }

  /**
   * Change audio settings live: processing via constraints, a new microphone via re-capture and
   * replaceTrack, speaker via setSinkId. A microphone switch is persisted only once it succeeded;
   * switches are serialised so a slow one cannot stop a newer track.
   */
  let audioChain: Promise<void> = Promise.resolve();
  function changeAudio(change: Partial<AudioSettings>): Promise<void> {
    audioChain = audioChain.then(() => changeAudioNow(change)).catch((e) => console.warn('audio settings', e));
    return audioChain;
  }
  async function changeAudioNow(change: Partial<AudioSettings>): Promise<void> {
    const prev = audioSettings();
    const next = { ...prev, ...change };
    if (voiceTrack && next.microphoneId !== prev.microphoneId) {
      storeAudioSettings(next); // so microphoneConstraints() sees the new id
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
      } catch (e) {
        storeAudioSettings(prev); // roll back: the old microphone stays live and selected
        console.warn('microphone switch failed', e);
        return;
      }
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.enabled = !muted();
        await Promise.all([...peers.values()].map((p) => p.tx[SLOT_INDEX.voice]?.sender.replaceTrack(track)));
        voiceTrack.stop();
        voiceTrack = track;
        localStream = stream;
        localAnalyser = analyserFor('me', stream);
      }
    } else {
      storeAudioSettings(next);
      if (voiceTrack) await voiceTrack.applyConstraints(microphoneConstraints()).catch((e) => console.warn('applyConstraints audio', e));
    }
    if (next.speakerId !== prev.speakerId) for (const p of peers.values()) { void applySink(p.audio); void applySink(p.shareAudio); }
  }

  /** Change share settings live: track constraints and content hint on the capture, encodings per Viewer. */
  function setShareSettings(next: ShareSettings): void {
    storeShareSettings(next);
    if (shareVideo) {
      shareVideo.applyConstraints(trackConstraints(next)).catch((e) => console.warn('applyConstraints share', e));
      shareVideo.contentHint = contentHint(next);
    }
    reapplyShareEncodings();
  }
  const setPreset = (preset: PresetName) => setShareSettings(applyPreset(shareSettings(), preset));
  const changeShare = (change: Partial<Omit<ShareSettings, 'preset'>>) => setShareSettings(withChange(shareSettings(), change));

  /** Set how loud one participant is for me: their voice and share audio, nothing sent anywhere (ticket 08). */
  function setVolume(key: string, value: number): void {
    const v = clampVolume(value);
    const peer = peers.get(key);
    if (peer) {
      if (peer.voiceGain) peer.voiceGain.gain.value = v;
      if (peer.shareGain) peer.shareGain.gain.value = v;
      setView(peer, { volume: v });
    }
    const next = { ...untrack(volumes) };
    if (v === 1) delete next[key]; else next[key] = v;
    storeVolumes(next);
  }

  function setViewerSettings(next: ViewerSettings): void {
    storeViewerSettings(next);
    for (const p of peers.values()) for (const slot of [SLOT_INDEX.shareVideo, SLOT_INDEX.shareAudio]) { const r = p.tx[slot]?.receiver; if (r) applyJitterTarget(r); }
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
    const keepAlive = new Audio();
    keepAlive.autoplay = true;
    keepAlive.muted = true;
    const peer: Peer = {
      key, name, pc, polite: isPolite(myKey, key), tx: [], makingOffer: false, ignoreOffer: false, srdAnswerPending: false, audio, keepAlive, audioNodes: [], restarts: 0,
      view: { publicKey: key, name, conn: 'connecting', speaking: false, serverLost: false, audioBytesIn: 0, watching: false, shareLive: false, shareKbps: 0, shareFormat: null, volume: untrack(volumes)[key] ?? 1 },
      viewsMyShare: earlyViewers.has(key), viewerScale: earlyViewers.get(key) ?? 1, remoteShare: new MediaStream(), shareAudio: new Audio(), videoBytesIn: 0, videoBytesAt: 0, videoBytesOut: 0, outKbps: 0, outFormat: null, encodingChain: Promise.resolve(),
      outgoingCandidates: [],
    };
    earlyViewers.delete(key);
    peer.shareAudio.autoplay = true;
    void applySink(peer.audio);
    void applySink(peer.shareAudio);
    setShareStreams((m) => new Map(m).set(key, peer.remoteShare));
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
    pc.onicecandidate = ({ candidate }) => {
      peer.outgoingCandidates.push(candidate ? candidate.toJSON() : null);
      peer.candidateTimer ??= setTimeout(() => flushCandidates(peer), CANDIDATE_BATCH_MS);
    };
    pc.oniceconnectionstatechange = () => onIceState(peer);
    armConnectWatchdog(peer, initiator);
    pc.ontrack = ({ track, transceiver }) => {
      // Fires inside setRemoteDescription, before the answerer has recorded its transceivers,
      // so identify the slot by position in the connection's transceiver list, not via peer.tx.
      const slot = pc.getTransceivers().indexOf(transceiver);
      if (track.kind === 'audio' && slot === SLOT_INDEX.voice) {
        wireRemoteAudio(peer, 'voice', new MediaStream([track]));
      } else if (slot === SLOT_INDEX.shareVideo || slot === SLOT_INDEX.shareAudio) {
        // Share tracks exist from join time, muted and empty until the sharer sends. "Live" follows the
        // unmute/mute events, which is how a viewer knows frames are actually arriving (spec §6.5).
        peer.remoteShare.addTrack(track);
        applyJitterTarget(transceiver.receiver);
        if (slot === SLOT_INDEX.shareVideo) {
          track.onunmute = () => setView(peer, { shareLive: true });
          track.onmute = () => setView(peer, { shareLive: false, shareKbps: 0, shareFormat: null });
        } else {
          // The tile's video element is muted (autoplay), so share audio plays through its own element, gain-adjusted.
          wireRemoteAudio(peer, 'share', new MediaStream([track]));
        }
      }
    };
    peers.set(key, peer);
    publish();
    return peer;
  }

  /**
   * Remote audio path (ticket 08): raw track -> gain (0 to 200 percent, local only) -> a MediaStream that a
   * normal audio element plays, so speaker selection via setSinkId keeps working. The raw track also stays
   * attached to a muted element, which Chrome requires before it feeds remote audio into WebAudio at all.
   */
  function wireRemoteAudio(peer: Peer, kind: 'voice' | 'share', stream: MediaStream): void {
    const out = kind === 'voice' ? peer.audio : peer.shareAudio;
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (kind === 'voice') { peer.keepAlive.srcObject = stream; peer.keepAlive.play().catch(() => {}); }
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = peer.view.volume;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain).connect(dest);
    peer.audioNodes.push(source, gain, dest);
    if (kind === 'voice') {
      peer.voiceGain = gain;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      source.connect(an); // speaking detection measures the friend's real level, before your local gain
      peer.analyser = an;
      peer.audioNodes.push(an);
    } else {
      peer.shareGain = gain;
    }
    out.srcObject = dest.stream;
    out.play().catch(() => { /* needs a gesture on some browsers; the join click normally suffices */ });
  }

  function attachLocalTracks(peer: Peer): void {
    const voiceSender = peer.tx[SLOT_INDEX.voice]?.sender;
    if (voiceSender && voiceTrack) voiceSender.replaceTrack(voiceTrack).catch((e) => console.warn('replaceTrack voice', e));
    if (shareVideo) {
      // A share flows to nobody until they subscribe: deactivate both share senders as soon as the
      // answer has produced encodings. Both replaceTrack calls settle before the encoding is applied.
      const video = peer.tx[SLOT_INDEX.shareVideo]?.sender.replaceTrack(shareVideo);
      const audio = shareAudio ? peer.tx[SLOT_INDEX.shareAudio]?.sender.replaceTrack(shareAudio) : undefined;
      Promise.all([video, audio]).then(() => applyShareEncoding(peer)).catch((e) => console.warn('replaceTrack share', e));
    }
  }

  /**
   * Sender-side toggle for one Viewer: active follows their subscription, bitrate follows the budget rule
   * (spec §6.4). Retries every 100 ms until the answer has produced encodings, for as long as the share
   * and the connection live (ADR 0001: deactivation must wait for the answer, never give up).
   */
  function applyShareEncoding(peer: Peer): Promise<void> {
    peer.encodingChain = peer.encodingChain.then(() => applyShareEncodingNow(peer)).catch((e) => console.warn('setParameters share', e));
    return peer.encodingChain;
  }
  async function applyShareEncodingNow(peer: Peer): Promise<void> {
    if (!shareVideo || peer.pc.connectionState === 'closed') return;
    const viewers = [...peers.values()].filter((p) => p.viewsMyShare).length;
    const enc = shareEncoding(shareSettings(), viewers, peer.viewerScale);
    for (const slot of [SLOT_INDEX.shareVideo, SLOT_INDEX.shareAudio]) {
      const sender = peer.tx[slot]?.sender;
      if (!sender?.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) {
        setTimeout(() => void applyShareEncoding(peer), 100);
        return;
      }
      params.encodings[0]!.active = peer.viewsMyShare;
      if (slot === SLOT_INDEX.shareVideo) {
        Object.assign(params.encodings[0]!, { maxBitrate: enc.maxBitrate, maxFramerate: enc.maxFramerate, scaleResolutionDownBy: enc.scaleResolutionDownBy });
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = enc.degradationPreference;
      }
      await sender.setParameters(params);
    }
  }

  /** Re-apply the budget split to every current Viewer when the viewer set changes. */
  function reapplyShareEncodings(): void {
    for (const p of peers.values()) if (p.viewsMyShare) void applyShareEncoding(p);
  }

  function flushCandidates(peer: Peer): void {
    peer.candidateTimer = undefined;
    if (!peer.outgoingCandidates.length) return;
    const candidates = peer.outgoingCandidates.splice(0, 64);
    if (candidates.some((c) => typeof (c as { candidate?: string } | null)?.candidate === 'string' && (c as { candidate: string }).candidate.includes(' relay '))) posthog.capture('relay_candidate_gathered');
    room.send({ t: 'signal', to: peer.key, data: { candidates } });
    if (peer.outgoingCandidates.length) peer.candidateTimer = setTimeout(() => flushCandidates(peer), 0);
  }

  /**
   * Signals from one participant are applied in arrival order, one at a time, keyed by identity rather
   * than by connection object: the very first offer creates the connection while awaiting
   * setRemoteDescription, and the candidates behind it must wait for that, not race past it.
   */
  const signalChains = new Map<string, Promise<void>>();
  function onSignal(from: string, data: SignalData): void {
    const chain = (signalChains.get(from) ?? Promise.resolve()).then(() => onSignalNow(from, data)).catch((e) => console.warn('signal handling failed', e));
    signalChains.set(from, chain);
  }

  async function onSignalNow(from: string, data: SignalData): Promise<void> {
    if (!joined) return;
    let peer = peers.get(from);
    const isOffer = (data.description as RTCSessionDescriptionInit | undefined)?.type === 'offer';
    if (peer && isOffer && (peer.view.serverLost || peer.pc.iceConnectionState === 'failed' || peer.pc.connectionState === 'closed')) {
      // A fresh offer from a peer whose old connection is dead or who vanished and came back: start over.
      closePeer(from);
      peer = undefined;
    }
    if (!peer) {
      // Match the participant entry: a ghost of the same identity may still be listed as a visitor.
      const person = room.people().find((p) => p.publicKey === from && p.role === 'participant');
      if (!person) { posthog.capture('signal_dropped', { reason: 'sender not a participant', offer: isOffer }); return; }
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
      }
      if (data.candidates) {
        for (const c of data.candidates) {
          try {
            await pc.addIceCandidate((c as RTCIceCandidateInit | null) ?? undefined);
          } catch (e) {
            if (!peer.ignoreOffer) throw e;
          }
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
      clearTimeout(peer.connectTimer);
      stuckAttempts.delete(peer.key);
      if (peer.view.conn === 'connecting' || peer.view.conn === 'reconnecting' || peer.view.conn === 'unreachable') setView(peer, { conn: 'direct' });
      void refreshStats(peer);
    } else if (s === 'disconnected') {
      setView(peer, { conn: 'reconnecting' });
      // A peer whose server socket is gone cannot be signalled, so an ICE restart would only produce
      // "not in the call" errors: once their media fails too, the connection is over. They re-offer on return.
      peer.disconnectTimer = setTimeout(() => {
        if (peer.pc.iceConnectionState !== 'disconnected') return;
        if (peer.view.serverLost) closePeer(peer.key); else void restartIce(peer);
      }, ICE_DISCONNECTED_GRACE_MS);
    } else if (s === 'failed') {
      if (peer.view.serverLost) { closePeer(peer.key); return; }
      setView(peer, { conn: 'unreachable' });
      const delay = ICE_RESTART_BACKOFF_MS[Math.min(peer.restarts, ICE_RESTART_BACKOFF_MS.length - 1)]!;
      peer.restarts++;
      peer.restartTimer = setTimeout(() => void restartIce(peer), delay);
    } else if (s === 'closed') {
      setView(peer, { conn: 'unreachable' });
    }
  }

  const pick = (r: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));

  /** One peer as a problem report sees it: states, the share track, decoder and encoder counters, the selected pair (ticket 12). */
  async function peerDiag(peer: Peer): Promise<PeerDiagnostics> {
    let inboundVideo: Record<string, unknown> | null = null;
    let outboundVideo: Record<string, unknown> | null = null;
    let pair: PeerDiagnostics['pair'] = null;
    try {
      const st = await peer.pc.getStats();
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
            pair = { local: String(local?.['candidateType'] ?? '?'), remote: String(remote?.['candidateType'] ?? '?'), state: cp.state };
          }
        }
      });
    } catch { /* connection closed meanwhile */ }
    const track = peer.remoteShare.getVideoTracks()[0];
    const { conn, watching, shareLive, shareKbps, shareFormat, serverLost, volume } = peer.view;
    return {
      fingerprint: untrack(room.people).find((p) => p.publicKey === peer.key)?.fingerprint ?? null, polite: peer.polite, restarts: peer.restarts, viewsMyShare: peer.viewsMyShare, viewerScale: peer.viewerScale,
      view: { conn, watching, shareLive, shareKbps, shareFormat, serverLost, volume },
      pc: { connection: peer.pc.connectionState, ice: peer.pc.iceConnectionState, signaling: peer.pc.signalingState, gathering: peer.pc.iceGatheringState, transceivers: peer.pc.getTransceivers().length },
      shareTrack: track ? { readyState: track.readyState, muted: track.muted } : null,
      inboundVideo, outboundVideo, pair,
    };
  }

  /** Everything a problem report wants to know about the call (ticket 12). */
  async function diagnostics(): Promise<CallDiagnostics> {
    const { echoCancellation, noiseSuppression, autoGainControl } = untrack(audioSettings);
    return {
      inCall: joined, muted: untrack(muted), joinSeq: myJoinSeq,
      sharing: shareVideo ? { ...shareVideo.getSettings(), readyState: shareVideo.readyState, contentHint: shareVideo.contentHint } : null,
      outgoing: untrack(outgoing), shareSettings: untrack(shareSettings), viewerSettings: untrack(viewerSettings), audioProcessing: { echoCancellation, noiseSuppression, autoGainControl },
      ice: { servers: iceServers.length, turn: iceServers.some((s) => [s.urls].flat().some((u) => String(u).startsWith('turn'))), ageMinutes: iceIssuedAt ? Math.round((Date.now() - iceIssuedAt) / 60000) : null },
      peers: await Promise.all([...peers.values()].map(peerDiag)),
    };
  }

  /**
   * A watched share whose tile shows nothing after a few seconds although bytes arrive (reported by
   * friends). Record what the decoder and the element say, then ask for the share again: the sharer
   * deactivates and reactivates the encoding, which starts it with a fresh key frame.
   */
  async function reportBlackShare(key: string, element: Record<string, unknown>): Promise<void> {
    const peer = peers.get(key);
    if (!peer || !peer.view.watching) return;
    const diag = await peerDiag(peer);
    posthog.capture('share_black', { element: JSON.stringify(element), peer: JSON.stringify(diag), attempt: element['attempt'] });
    if (!peers.has(key) || !peer.view.watching) return;
    watch(key, false);
    watch(key, true);
  }

  /**
   * Stuck-connecting watchdog (spec §8.2). A connection that never left "connecting" gets reported
   * with everything the browser knows, then torn down and offered again by whoever noticed: perfect
   * negotiation sorts out the collision if both do. This is what a page reload used to achieve by hand.
   */
  const stuckAttempts = new Map<string, number>();
  function armConnectWatchdog(peer: Peer, initiator: boolean): void {
    const attempt = stuckAttempts.get(peer.key) ?? 0;
    peer.connectTimer = setTimeout(() => void connectWatchdog(peer, initiator, attempt), stuckDelay(attempt, initiator));
  }
  async function connectWatchdog(peer: Peer, initiator: boolean, attempt: number): Promise<void> {
    const stillStuck = () => peers.get(peer.key) === peer && peer.view.conn === 'connecting' && peer.pc.connectionState !== 'closed';
    if (!stillStuck()) return;
    const counts = { candidates_local: 0, candidates_remote: 0, candidates_relay: 0 };
    try {
      (await peer.pc.getStats()).forEach((r) => {
        if (r.type === 'local-candidate') { counts.candidates_local++; if ((r as { candidateType?: string }).candidateType === 'relay') counts.candidates_relay++; }
        else if (r.type === 'remote-candidate') counts.candidates_remote++;
      });
    } catch { /* closed meanwhile */ }
    posthog.capture('peer_connecting_slow', {
      attempt, initiator, polite: peer.polite, signaling: peer.pc.signalingState, ice: peer.pc.iceConnectionState, gathering: peer.pc.iceGatheringState,
      remote_description: peer.pc.remoteDescription !== null, local_description: peer.pc.localDescription !== null, peers: peers.size, ...counts,
    });
    if (!stillStuck()) return;
    const person = untrack(room.people).find((p) => p.publicKey === peer.key && p.role === 'participant');
    closePeer(peer.key);
    if (!joined || !person) return;
    stuckAttempts.set(peer.key, attempt + 1);
    createPeer(peer.key, person.name, true);
  }

  async function restartIce(peer: Peer): Promise<void> {
    if (peer.pc.connectionState === 'closed') return;
    posthog.capture('ice_restart', { attempt: peer.restarts, ice_state: peer.pc.iceConnectionState });
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
    let videoBytesOut = 0;
    let inFormat: VideoFormat | null = null;
    let outFormat: VideoFormat | null = null;
    type VideoRtp = { frameWidth?: number; frameHeight?: number; framesPerSecond?: number };
    const formatOf = (r: VideoRtp): VideoFormat | null => (r.frameWidth && r.frameHeight ? { width: r.frameWidth, height: r.frameHeight, fps: r.framesPerSecond ?? 0 } : null);
    st.forEach((r) => {
      if (r.type === 'inbound-rtp') {
        const rtp = r as RTCInboundRtpStreamStats & VideoRtp;
        if (rtp.kind === 'audio') audioBytesIn += rtp.bytesReceived ?? 0;
        if (rtp.kind === 'video') { videoBytesIn += rtp.bytesReceived ?? 0; inFormat = formatOf(rtp) ?? inFormat; }
      } else if (r.type === 'outbound-rtp') {
        const rtp = r as RTCOutboundRtpStreamStats & VideoRtp;
        if (rtp.kind === 'video') { videoBytesOut += rtp.bytesSent ?? 0; outFormat = formatOf(rtp) ?? outFormat; }
      }
    });
    if (audioBytesIn !== peer.view.audioBytesIn) peer.view.audioBytesIn = audioBytesIn;
    const now = Date.now();
    // Only rate over a meaningful window; onIceState and the 2 s timer can call this back to back.
    if (peer.videoBytesAt && now - peer.videoBytesAt >= 500) {
      const kbps = Math.round(((videoBytesIn - peer.videoBytesIn) * 8) / (now - peer.videoBytesAt));
      if (peer.view.shareLive && (kbps !== peer.view.shareKbps || !sameFormat(inFormat, peer.view.shareFormat))) setView(peer, { shareKbps: kbps, shareFormat: inFormat });
      peer.outKbps = Math.max(0, Math.round(((videoBytesOut - peer.videoBytesOut) * 8) / (now - peer.videoBytesAt)));
      peer.outFormat = outFormat;
      peer.videoBytesIn = videoBytesIn;
      peer.videoBytesOut = videoBytesOut;
      peer.videoBytesAt = now;
      updateOutgoing();
    } else if (!peer.videoBytesAt) {
      peer.videoBytesIn = videoBytesIn;
      peer.videoBytesOut = videoBytesOut;
      peer.videoBytesAt = now;
    }
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

  /** Sum my share's upload over its viewers and list the encoded formats, largest first (spec §6.5). */
  function updateOutgoing(): void {
    if (!shareVideo) { if (untrack(outgoing)) setOutgoing(null); return; }
    const viewers = [...peers.values()].filter((p) => p.viewsMyShare);
    const next: OutgoingShare = {
      kbps: viewers.reduce((sum, p) => sum + p.outKbps, 0),
      formats: distinctFormats(viewers.map((p) => p.outFormat).filter((f): f is VideoFormat => f !== null)),
      viewers: viewers.length,
    };
    const prev = untrack(outgoing);
    if (!prev || prev.kbps !== next.kbps || prev.viewers !== next.viewers || JSON.stringify(prev.formats) !== JSON.stringify(next.formats)) setOutgoing(next);
  }

  function closePeer(key: string): void {
    const peer = peers.get(key);
    if (!peer) return;
    clearTimeout(peer.disconnectTimer); clearTimeout(peer.restartTimer); clearTimeout(peer.graceTimer); clearTimeout(peer.candidateTimer); clearTimeout(peer.connectTimer);
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.shareAudio.srcObject = null;
    peer.keepAlive.srcObject = null;
    for (const n of peer.audioNodes) n.disconnect();
    sources.get(key)?.disconnect();
    sources.delete(key);
    peers.delete(key);
    signalChains.delete(key);
    lastLoud.delete(key);
    setShareStreams((m) => { const n = new Map(m); n.delete(key); return n; });
    publish();
    if (peer.viewsMyShare) reapplyShareEncodings(); // the budget re-splits among the remaining Viewers
  }

  /** Server presence is authoritative for membership; media follows it (spec §8.2). */
  function reconcile(people: Person[]): void {
    const self = people.find((p) => p.publicKey === myKey);
    if (!joined || !self || self.role !== 'participant') return;
    for (const p of people) {
      if (p.publicKey === myKey || p.role !== 'participant') continue;
      const existing = peers.get(p.publicKey);
      if (existing) {
        if (existing.view.serverLost) { clearTimeout(existing.graceTimer); setView(existing, { serverLost: false, name: p.name }); }
        // Their share ended: my subscription is void, the tile goes back to "click to watch" (spec §6.5).
        if (!p.sharing && existing.view.watching) setView(existing, { watching: false, shareLive: false, shareKbps: 0, shareFormat: null });
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
        posthog.capture('peer_server_lost', { ice: peer.pc.iceConnectionState });
        const ice = peer.pc.iceConnectionState;
        if (ice === 'failed' || ice === 'closed' || ice === 'new') { closePeer(peer.key); continue; } // nothing worth keeping
        setView(peer, { serverLost: true });
        peer.graceTimer = setTimeout(() => closePeer(peer.key), PEER_GRACE_MS);
      }
    }
  }
  createEffect(() => room.people(), (people) => { reconcile(people); }); // block body: never return a value from an effect callback

  // Re-declare after our own server reconnect (spec §8.1): peer connections stay, join sequence is fresh.
  createEffect(() => room.status().kind, (kind, prev) => {
    if (kind === 'connected' && prev !== undefined && prev !== 'connected' && joined) void rejoinAfterReconnect();
    if (kind === 'elsewhere' && joined) leave(); // another tab took over; this one is no longer in the call
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
    const m = await awaitReply('call', () => room.send({ t: 'join', muted: muted(), sharing: shareVideo !== null }), 8000);
    if (m) { myJoinSeq = m.joinSeq; iceServers = m.iceServers; iceIssuedAt = m.issuedAt; }
    return m;
  }

  const unsubscribe = room.subscribe((m) => {
    switch (m.t) {
      case 'call': pending.get('call')?.(m); return;
      case 'ice': pending.get('ice')?.(m); return;
      case 'signal': onSignal(m.from, m.data); return;
      case 'left': closePeer(m.publicKey); return;
      case 'subscribe': {
        const peer = peers.get(m.from);
        if (!peer) { if (m.on) earlyViewers.set(m.from, m.scale ?? 1); else earlyViewers.delete(m.from); return; }
        peer.viewsMyShare = m.on;
        peer.viewerScale = m.scale ?? 1;
        if (!m.on) { peer.outKbps = 0; peer.outFormat = null; }
        updateOutgoing();
        reapplyShareEncodings();
        if (!m.on) void applyShareEncoding(peer); // the one leaving must be deactivated too
        return;
      }
    }
  });

  // ---- shares (spec §6.2, §6.5)
  async function startShare(): Promise<void> {
    if (!joined || shareVideo) return;
    setShareError(null);
    let stream: MediaStream;
    try {
      const fps = shareSettings().frameRate;
      const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
        video: { frameRate: { ideal: fps, max: fps } },
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
    shareVideo.contentHint = contentHint(shareSettings());
    shareVideo.applyConstraints(trackConstraints(shareSettings())).catch(() => {});
    shareVideo.onended = () => stopShare(); // the browser's own "stop sharing" control
    for (const peer of peers.values()) attachLocalTracks(peer);
    setSharing(stream);
    setOutgoing({ kbps: 0, formats: [], viewers: [...peers.values()].filter((p) => p.viewsMyShare).length });
    room.send({ t: 'share', on: true });
    posthog.capture('screen_share_started');
  }

  /**
   * Stop sharing. `announce` is false when leaving, where the server clears the flag itself.
   * Everything the UI reads changes synchronously; detaching from the senders is not awaited because
   * Firefox never settles replaceTrack once the connection closes underneath it (leave), which used to
   * leave the "sharing" state stuck until a reload.
   */
  function stopShare(announce = true): void {
    if (!shareVideo) return;
    shareVideo.stop();
    shareAudio?.stop();
    shareVideo = null;
    shareAudio = null;
    earlyViewers.clear();
    setSharing(null);
    setOutgoing(null);
    if (announce) room.send({ t: 'share', on: false });
    posthog.capture('screen_share_stopped');
    for (const peer of peers.values()) {
      peer.viewsMyShare = false;
      peer.outKbps = 0; peer.outFormat = null;
      for (const slot of [SLOT_INDEX.shareVideo, SLOT_INDEX.shareAudio]) void peer.tx[slot]?.sender.replaceTrack(null).catch(() => {});
    }
  }

  /** Viewer side: ask the sharer to start or stop sending me their share. */
  function watch(key: string, on: boolean): void {
    const peer = peers.get(key);
    if (!peer || peer.view.watching === on) return;
    setView(peer, { watching: on, shareKbps: 0, shareFormat: null });
    posthog.capture('screen_watch_toggled', { watching: on });
    // A small screen asks the sharer for a downscaled encoding for this connection only (spec §6.4).
    room.send(smallScreen() ? { t: 'subscribe', to: key, on, scale: 2 } : { t: 'subscribe', to: key, on });
  }

  /** Fullscreen on one share unsubscribes every other (spec §6.5); leaving fullscreen does nothing. */
  function watchOnly(key: string): void {
    for (const p of peers.values()) if (p.key !== key && p.view.watching) watch(p.key, false);
    watch(key, true);
  }

  const shareStreamOf = (key: string): MediaStream | undefined => shareStreams().get(key);

  // ---- actions
  let joining = false;
  async function join(): Promise<void> {
    if (joined || joining) return;
    joining = true;
    setJoinError(null);
    try {
      try {
        await openMicrophone();
      } catch (e) {
        const joinErrMsg = e instanceof Error && e.name === 'NotAllowedError' ? 'Microphone access was denied.' : `Could not open the microphone: ${e instanceof Error ? e.message : String(e)}`;
        setJoinError(joinErrMsg);
        posthog.capture('join_error', { reason: 'microphone_denied' });
        return;
      }
      const reply = await declareJoin();
      if (!reply) { setJoinError('The server did not answer the join request.'); posthog.capture('join_error', { reason: 'server_no_answer' }); return; }
      setInCall(true);
      posthog.capture('call_joined');
      reconcile(untrack(room.people));
    } finally {
      joining = false;
    }
  }

  function leave(): void {
    if (!joined) return;
    posthog.capture('call_left');
    stopShare(false); // the server clears the sharing flag on leave
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
    if (joined) room.send({ t: 'mute', muted: m });
    posthog.capture('mute_toggled', { muted: m });
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
      peers: () => [...peers.values()].map((p) => ({ name: p.name, ice: p.pc.iceConnectionState, conn: p.view.conn, audioBytesIn: p.view.audioBytesIn, videoBytesIn: p.videoBytesIn, watching: p.view.watching, shareLive: p.view.shareLive, subscribedToMe: p.viewsMyShare, transceivers: p.pc.getTransceivers().length })),
      share: () => ({
        settings: shareSettings(),
        outgoing: untrack(outgoing),
        track: shareVideo ? { ...shareVideo.getSettings(), contentHint: shareVideo.contentHint } : null,
        senders: [...peers.values()].map((p) => { const params = p.tx[SLOT_INDEX.shareVideo]?.sender.getParameters(); const e = params?.encodings?.[0]; return { name: p.name, active: e?.active, maxBitrate: e?.maxBitrate, maxFramerate: e?.maxFramerate, scale: e?.scaleResolutionDownBy, degradation: (params as { degradationPreference?: string } | undefined)?.degradationPreference }; }),
      }),
      audio: () => ({ settings: audioSettings(), track: voiceTrack?.getSettings() ?? null }),
      volumes: () => [...peers.values()].map((p) => ({ name: p.name, voiceGain: p.voiceGain?.gain.value ?? null, shareGain: p.shareGain?.gain.value ?? null, view: p.view.volume, sink: (p.audio as HTMLAudioElement & { sinkId?: string }).sinkId ?? '' })),
      dropSocket: () => room.dropSocket(),
      diagnostics,
      state: () => ({ inCall: joined, joining, joinError: untrack(joinError), myJoinSeq, role: untrack(me)?.role ?? null, participants: untrack(room.people).filter((p) => p.role === 'participant').map((p) => `${p.name}#${p.joinSeq}`) }),
    };
  }

  return {
    inCall, muted, views, speakingSelf, joinError, join, leave, setMuted, myJoinSeq: () => myJoinSeq,
    sharing, shareError, outgoing, startShare, stopShare, watch, watchOnly, shareStreamOf,
    shareSettings, setPreset, changeShare, audioSettings, changeAudio, viewerSettings, setViewerSettings, devices, refreshDevices, canPickSpeaker,
    setVolume, canPickSpeakerDialog, pickSpeaker,
    diagnostics, reportBlackShare,
  };
}
