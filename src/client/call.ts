import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { distinctFormats, type VideoFormat } from '../core/format';
import { stuckDelay, transportPolicyFor } from '../core/mesh';
import posthog from './posthog';
import { exposeHooks } from './hooks';
import { isFreshConnection, signDescription, verifyDescription } from '../core/dtls';
import { CLOSED, closeLatch, keyedChain, unlessClosed } from '../core/signalchain';
import { LOW_VOICE_BUFFER_MS, asksLowVoice, lowVoiceSdp } from '../core/lowvoice';
import { asksFec, sendsRed, voiceRepairSdp, type VoiceRepair } from '../core/voicerepair';
import { INITIAL_BUFFER, VOICE_REPORT_EVERY, VOICE_SAMPLE_MS, bufferMs, nextBuffer, voiceWindow, type BufferState, type VoiceCounters, type VoiceWindow } from '../core/voicequality';
import type { LocalIdentity } from './identity';
import { candidateCounts, reportStats, summarise, voiceCounters, windowProps } from './peerstats';
import {
  ICE_DISCONNECTED_GRACE_MS, ICE_REFRESH_AFTER_MS, ICE_RESTART_BACKOFF_MS, PEER_GRACE_MS, SLOT_INDEX, initiatesTo, isPolite,
} from '../core/mesh';
import type { IceServer, Person, ServerMessage, SignalData } from '../core/protocol';
import {
  SMALL_SCREEN_QUERY, captureProcessing, clampVolume, contentHint, parseAudioSettings, parseShareSettings, parseViewerSettings, parseVolumes, shareEncoding, trackConstraints, withChange,
  type AudioSettings, type ShareSettings, type ViewerSettings,
} from '../core/settings';
import { REJOIN_HEARTBEAT_MS, parseRejoinMarker, rejoinFor, type RejoinMarker } from '../core/rejoin';
import type { createRoom } from './room';
import { tryUnlockSound } from './sound';
import { local } from './storage';
import { canRemoveNoise, createVoiceProcessor, type VoiceLevel, type VoiceLoad, type VoiceProcessor } from './voice';
import { createVoiceGuard, sendRatePct, type ClockSample, type GuardFault } from '../core/voiceclock';

export type ConnState = 'connecting' | 'direct' | 'relayed' | 'reconnecting' | 'unreachable';
/** Noise removal as the Audio panel shows it (ticket 26): `starting` until the processed voice is what peers get. */
export type NoiseRemovalState = 'off' | 'starting' | 'on' | 'unavailable';
/** Why noise removal gave up mid-call (ticket 37): the voice it sent ran off real time, or the device could not keep up. */
export type NoiseRemovalStop = GuardFault['reason'];

/**
 * The mic test (ticket 40): hearing my own voice live, or recording 5 s of it and playing them back. While one runs,
 * friends get silence and see me muted, and I hear none of them.
 */
export type MicTest = 'live' | 'recording' | 'playing';
export const MIC_TEST_RECORD_MS = 5000;
/** Why a mic test ended, for telemetry. */
export type MicTestEnd = 'stop' | 'played' | 'panel' | 'mute' | 'leave' | 'hidden' | 'failed';

/** My own share as the sharer sees it: total upload, the distinct encoded formats, how many watch. */
export type OutgoingShare = { kbps: number; formats: VideoFormat[]; viewers: number };

/** Snapshot for problem reports (ticket 12): states and counters, no names, no message texts. */
export type PeerDiagnostics = {
  fingerprint: string | null; polite: boolean; restarts: number; relayOnly: boolean; viewsMyShare: boolean; viewerScale: number; asksLowVoice: boolean; voiceBufferMs: number | null;
  /** My voice to them goes as RED, or with Opus FEC: their description, as applied, lists RED first, or asks for FEC (ticket 34). */
  sendsRed: boolean;
  sendsFec: boolean;
  /** The buffer that follows the line (ticket 34): what it asks for now, and the last 5 s window it judged. */
  voiceBuffer: { adaptiveMs: number | null; level: number; lastWindow: VoiceWindow | null };
  view: Pick<PeerView, 'conn' | 'watching' | 'shareLive' | 'shareKbps' | 'shareFormat' | 'serverLost' | 'volume' | 'rttMs'>;
  pc: { connection: RTCPeerConnectionState; ice: RTCIceConnectionState; signaling: RTCSignalingState; gathering: RTCIceGatheringState; transceivers: number };
  shareTrack: { readyState: string; muted: boolean } | null;
  inboundVideo: Record<string, unknown> | null;
  outboundVideo: Record<string, unknown> | null;
  /** The voice both ways (ticket 27): what arrives and how it plays, what I send and what the other side says of it. */
  inboundVoice: Record<string, unknown> | null;
  outboundVoice: Record<string, unknown> | null;
  pair: { local: string; remote: string; state: string; rttMs: number | null; outgoingKbps: number | null } | null;
};
export type CallDiagnostics = {
  inCall: boolean; muted: boolean; microphone: boolean; micTest: MicTest | null; joinSeq: number | null; sharing: Record<string, unknown> | null; outgoing: OutgoingShare | null;
  shareSettings: unknown; viewerSettings: unknown; audioProcessing: unknown; lowBandwidthVoice: boolean; voiceRepair: VoiceRepair; ice: { servers: number; turn: boolean; ageMinutes: number | null };
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
  /** Round trip to them in ms, the larger of ICE's and RTCP's latest measurement; null until one exists (ticket 27). */
  rttMs: number | null;
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
  /** Built with iceTransportPolicy "relay": a rebuild after a stalled attempt (ticket 22). */
  relayOnly: boolean;
  /** Which RTCPeerConnection of this tab this is (dev hook). */
  generation: number;
  /** Settles when closePeer closes the connection; see `unlessClosed`. */
  closed: Promise<void>;
  markClosed: () => void;
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
  /** Their last description asked for low bandwidth voice (ticket 27). Reports only: my side follows it by itself. */
  asksLowVoice: boolean;
  /** Their description as applied lists RED first, or asks for Opus FEC: my encoder obeys it (ticket 34). Reports only. */
  sendsRed: boolean;
  sendsFec: boolean;
  /** The voice receiver's counters at the last 5 s sample and at the last `voice_quality` event (ticket 34). */
  voiceLast: VoiceCounters | null;
  voiceReported: VoiceCounters | null;
  voiceSamples: number;
  /** The buffer that follows the line, and the window it last judged. */
  buffer: BufferState;
  lastWindow: VoiceWindow | null;
  /** Outgoing ICE candidates are batched for a moment to cut message count (each is a relay request). */
  outgoingCandidates: unknown[];
  candidateTimer?: ReturnType<typeof setTimeout>;
};
const CANDIDATE_BATCH_MS = 60;

/** How often `voice_send` reports how the voice I send keeps time (ticket 37). */
const VOICE_SEND_EVERY_MS = 30_000;

const SPEAK_THRESHOLD = 0.02;
const SPEAK_HOLD_MS = 300;

/**
 * The Call from this browser's point of view (ADR 0001): one RTCPeerConnection per other
 * participant, three fixed transceivers, perfect negotiation with polite = lower key,
 * newcomer initiates, all control over the room socket. Voice and one Share per participant.
 */
export function createCall(room: ReturnType<typeof createRoom>, identity: LocalIdentity, opts: { mayRejoin: boolean } = { mayRejoin: true }) {
  const myKey = identity.publicKey;
  const [inCall, setInCallSignal] = createSignal(false);
  // Solid 2 stages signal writes to a microtask, so code that runs right after a write still reads the old
  // value. Internal logic therefore uses this plain mirror; the signal is for rendering only.
  let joined = false;
  const setInCall = (v: boolean) => { joined = v; setInCallSignal(v); };
  const [muted, setMutedSignal] = createSignal(local.get('muted') === 'true');
  const [views, setViews] = createSignal<PeerView[]>([]);
  const [speakingSelf, setSpeakingSelf] = createSignal(false);
  const [joinError, setJoinError] = createSignal<string | null>(null);
  /** Why I am in the call without a microphone: none found, access denied. I listen, shown muted; Unmute asks again. */
  const [micProblem, setMicProblem] = createSignal<string | null>(null);
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
  /** Sharers whose share I have asked to watch. Kept apart from any one peer so a rebuild or a reconnect re-asserts it. */
  const watchIntent = new Set<string>();

  // ---- Rejoin (ticket 24): a marker kept fresh while in the Call, read once when the page loads
  const REJOIN_KEY = 'rejoin';
  const writeRejoinMarker = () => {
    const m: RejoinMarker = { room: room.roomId, at: Date.now(), watching: [...watchIntent] };
    local.set(REJOIN_KEY, JSON.stringify(m));
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Written at every heartbeat and on pagehide: Android kills a background app without any page event. */
  const onPageHide = () => { if (joined) writeRejoinMarker(); };
  window.addEventListener('pagehide', onPageHide);
  /** Read at load: another tab superseding this one clears the marker, so a later read could miss it. A tab that waited
   * behind another open tab is not a reload and never rejoins (ticket 25): that tab may have just left the call by closing. */
  let pendingRejoin = opts.mayRejoin ? rejoinFor(parseRejoinMarker(local.get(REJOIN_KEY)), room.roomId, Date.now()) : null;
  /** Remote audio the browser refused to start without a gesture (a Rejoin normally avoids it by taking the mic first). */
  const [audioBlocked, setAudioBlocked] = createSignal(false);

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
  /** Plain mirror of the low bandwidth voice setting (ticket 27), read while descriptions go out and come in. */
  let lowVoiceOn = untrack(audioSettings).lowBandwidthVoice;
  let voiceRepair = untrack(audioSettings).voiceRepair;
  /** Every description crosses this on its way out and on its way in: low bandwidth voice (ticket 27), then voice repair (ticket 34). */
  const voiceSdp = (sdp: string): string => voiceRepairSdp(lowVoiceOn ? lowVoiceSdp(sdp) : sdp, voiceRepair);
  const [devices, setDevices] = createSignal<{ microphones: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }>({ microphones: [], speakers: [] });
  const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const smallScreen = () => typeof matchMedia !== 'undefined' && matchMedia(SMALL_SCREEN_QUERY).matches;

  const peers = new Map<string, Peer>();
  /** Stalled attempts per participant since the last successful connection; drives the watchdog delay and the relay fallback. */
  const stuckAttempts = new Map<string, number>();
  let localStream: MediaStream | null = null;
  let voiceTrack: MediaStreamTrack | null = null;
  let iceServers: IceServer[] = [];
  let iceIssuedAt = 0;
  /** Counts RTCPeerConnections built in this tab; the dev hook shows it so a driver can tell a rebuild from a renegotiation. */
  let generation = 0;
  const hasTurn = () => iceServers.some((s) => [s.urls].flat().some((u) => String(u).startsWith('turn')));
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
  /** Takes the settings explicitly where they were just written: a signal written in this run still reads the old value. */
  function microphoneConstraints(a: AudioSettings = untrack(audioSettings)): MediaTrackConstraints {
    const c: MediaTrackConstraints = captureProcessing(a, a.noiseRemoval && canRemoveNoise() && !removalUnavailable);
    // Hearing myself live, echo cancellation would take my own voice for an echo and cut it in and out; no friend plays to cancel.
    if (testing === 'live') c.echoCancellation = false;
    // `ideal`, not `exact`: a remembered microphone that is unplugged must not lock anyone out of the call.
    if (a.microphoneId) c.deviceId = { ideal: a.microphoneId };
    return c;
  }
  /** The constraints the live microphone was opened with, to tell whether the settings now ask for another. */
  let micOpenedWith = '';
  const capture = async (c: MediaTrackConstraints): Promise<MediaStream | null> => {
    try { return await navigator.mediaDevices.getUserMedia({ audio: c }); } catch (e) { console.warn('microphone reopen failed', e); return null; }
  };
  const PROCESSING = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;
  /** Whether a capture runs the processing `c` asked for, where the browser says. */
  const takes = (stream: MediaStream, c: MediaTrackConstraints): boolean => {
    const got = stream.getAudioTracks()[0]?.getSettings() ?? {};
    return PROCESSING.every((k) => c[k] === undefined || got[k] === undefined || got[k] === c[k]);
  };
  /**
   * Opens the microphone again with `c` and swaps it in. Chromium keeps the processing a track was opened with, whatever
   * applyConstraints says (2026-10-04, Chrome 153). A second capture of the same device gets its own processing switched
   * off, but not back on while the first runs without: then the first is stopped before the second, a moment of silence.
   * False when the browser refused, or the microphone was closed or replaced meanwhile.
   */
  async function reopenMicrophone(c: MediaTrackConstraints): Promise<boolean> {
    const old = voiceTrack;
    if (!old) return false;
    let stream = await capture(c);
    if (stream && voiceTrack === old && !takes(stream, c)) {
      stream.getTracks().forEach((t) => t.stop());
      old.stop();
      stream = await capture(c) ?? await capture(JSON.parse(micOpenedWith) as MediaTrackConstraints);
      if (!stream) posthog.capture('microphone_reopen_failed');
    }
    if (!stream) return false;
    const track = stream.getAudioTracks()[0];
    if (!track || voiceTrack !== old) { stream.getTracks().forEach((t) => t.stop()); return false; }
    track.enabled = micLive();
    voiceTrack = track;
    localStream = stream;
    micOpenedWith = JSON.stringify(c);
    voice?.setInput(stream); // the processed track stays the same; only while the microphone goes out as it is does a sender change
    await sendVoice();
    old.stop();
    localAnalyser = analyserFor('me', stream);
    return true;
  }
  /** Brings the live microphone in line with the settings and the mic test: opened again only when they ask for something else. */
  async function syncMicrophone(a: AudioSettings = untrack(audioSettings)): Promise<void> {
    if (!voiceTrack) return;
    const c = microphoneConstraints(a);
    if (JSON.stringify(c) !== micOpenedWith) await reopenMicrophone(c);
  }
  const micProblemOf = (e: unknown): string =>
    e instanceof Error && e.name === 'NotAllowedError' ? 'Microphone access was denied.'
    : e instanceof Error && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') ? 'No microphone found.'
    : `Could not open the microphone: ${e instanceof Error ? e.message : String(e)}`;
  async function openMicrophone(): Promise<void> {
    if (voiceTrack) return;
    const c = microphoneConstraints();
    localStream = await navigator.mediaDevices.getUserMedia({ audio: c });
    micOpenedWith = JSON.stringify(c);
    voiceTrack = localStream.getAudioTracks()[0] ?? null;
    if (voiceTrack) voiceTrack.enabled = !muted();
    audioCtx ??= new AudioContext();
    // With the microphone live, Chromium and Firefox let the context run without a gesture (research: rejoin without a click).
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
    localAnalyser = analyserFor('me', localStream);
    sendVoice();
    void startNoiseRemoval(); // not awaited: the microphone goes out as it is until RNNoise runs
    void refreshDevices();
  }

  // ---- noise removal (ticket 26)
  let voice: VoiceProcessor | null = null;
  let voiceReady = false;
  /** Bumped by every start and stop, so a setup that finishes after a newer one gives up. */
  let voiceGeneration = 0;
  /** Once it failed in this tab the browser's own noise suppression stays in charge, until the setting is toggled. */
  let removalUnavailable = false;
  let lastLevel: VoiceLevel = { voice: 0, open: false };
  const [noiseRemoval, setNoiseRemoval] = createSignal<NoiseRemovalState>('off');
  const [noiseRemovalStop, setNoiseRemovalStop] = createSignal<NoiseRemovalStop | null>(null);
  /** How the worker kept up over the last second of audio (frames path only). */
  let voiceLoad: VoiceLoad | null = null;
  /** A reading arrived since the guard last looked: each one counts once, though ticks and readings both come about once a second. */
  let loadFresh = false;
  const [voiceLevel, setVoiceLevel] = createSignal<VoiceLevel>(lastLevel);
  const onVoiceLevel = (l: VoiceLevel) => { lastLevel = l; setVoiceLevel(l); };

  /** What peers get: the processed voice once RNNoise runs and its context plays, the microphone's own track until then. */
  const outgoingVoice = (): MediaStreamTrack | null => (voice && voiceReady && voice.running() ? voice.track : voiceTrack);
  /** My voice as friends get it, a mic test aside: what the test plays back, the guard measures and my ring follows. */
  let sentVoice: MediaStreamTrack | null = null;
  /** What the voice senders carry: `sentVoice`, or silence while a mic test runs. */
  let wiredVoice: MediaStreamTrack | null = null;
  const wireFor = (track: MediaStreamTrack | null): MediaStreamTrack | null => (testing && track ? silence() : track);
  function sendVoice(): Promise<unknown> {
    const track = outgoingVoice();
    if (track !== sentVoice) { sentVoice = track; followMonitor(); }
    const wire = wireFor(track);
    if (wire === wiredVoice) return Promise.resolve();
    wiredVoice = wire;
    return Promise.all([...peers.values()].map((p) => p.tx[SLOT_INDEX.voice]?.sender.replaceTrack(wire).catch((e) => console.warn('replaceTrack voice', e))));
  }
  const showRemoval = () => setNoiseRemoval(voice && voiceReady ? (voice.running() ? 'on' : 'starting') : untrack(noiseRemoval));

  /** Takes the settings explicitly where they were just written. */
  async function startNoiseRemoval(a: AudioSettings = untrack(audioSettings)): Promise<void> {
    if (!a.noiseRemoval || !localStream || voice) return;
    const generation = ++voiceGeneration;
    const input = localStream;
    if (!canRemoveNoise()) { removalFailed('unsupported'); return; }
    setNoiseRemoval('starting');
    // The context can report its state while it is still being set up, before `v` is assigned.
    let v: VoiceProcessor | null = null;
    const onRunning = () => { if (v && voice === v) { sendVoice(); showRemoval(); } };
    try {
      v = await createVoiceProcessor(input, a.voiceThreshold, { level: onVoiceLevel, running: onRunning, load: (l) => { voiceLoad = { pct: l.pct, droppedMs: l.droppedMs, ...loadOverride }; loadFresh = true; } });
      if (generation !== voiceGeneration) { v.close(); return; }
      voice = v;
      if (localStream && localStream !== input) v.setInput(localStream); // the microphone was opened again meanwhile
      guard = createVoiceGuard(v.path);
      v.track.enabled = micLive();
      await v.ready;
      if (generation !== voiceGeneration) return;
      voiceReady = true;
      sendVoice();
      showRemoval();
    } catch (e) {
      if (generation === voiceGeneration) removalFailed(e instanceof Error ? e.message : String(e));
    }
  }
  function dropVoice(): void {
    voiceGeneration++;
    voiceReady = false;
    const v = voice;
    voice = null;
    sendVoice(); // back to the microphone before the processed track goes away
    v?.close();
    voiceLoad = null;
    guard.reset();
    onVoiceLevel({ voice: 0, open: false });
  }
  function stopNoiseRemoval(): void {
    dropVoice();
    setNoiseRemoval('off');
  }
  function removalFailed(reason: string, props: Record<string, unknown> = {}): void {
    dropVoice();
    removalUnavailable = true;
    setNoiseRemoval('unavailable');
    posthog.capture('noise_removal_unavailable', { reason, ...props });
    // It was off for RNNoise: the browser's own noise suppression takes over again.
    queueMicSync();
  }
  // ---- mic test (ticket 40)
  const [micTest, setMicTestSignal] = createSignal<MicTest | null>(null);
  /** Plain mirror of `micTest`, read on the way to the senders. */
  let testing: MicTest | null = null;
  const setTesting = (t: MicTest | null) => {
    const live = testing === 'live' || t === 'live';
    testing = t;
    setMicTestSignal(t);
    if (live) queueMicSync(); // echo cancellation off while I hear myself, back after
  };
  /** My microphone's tracks run while unmuted, and during a mic test even when muted: the test plays what friends would get. */
  const micLive = (): boolean => !untrack(muted) || testing !== null;
  /** Plays my live voice or the recording, on the chosen speaker. */
  const testOut = new Audio();
  /** The last recording, for Play until the call ends. */
  let clip: string | null = null;
  const [hasClip, setHasClip] = createSignal(false);
  let recorder: MediaRecorder | null = null;
  let recordTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever what plays or records stops, so a play() refused for that reason ends nothing newer. */
  let testMedia = 0;
  let testStarted = 0, testChanges = 0, testRecordings = 0, testUsedLive = false;
  /** Disabled, so friends get what a muted microphone sends. */
  let silent: MediaStreamTrack | null = null;
  function silence(): MediaStreamTrack {
    if (!silent) { silent = audioCtx!.createMediaStreamDestination().stream.getAudioTracks()[0]!; silent.enabled = false; }
    return silent;
  }
  /** `sentVoice` copied into the call's context, so what plays and what records follow it when it changes mid-test. */
  let monitor: { source: MediaStreamAudioSourceNode | null; track: MediaStreamTrack | null; dest: MediaStreamAudioDestinationNode; analyser: AnalyserNode } | null = null;
  function monitorStream(): MediaStream {
    if (!monitor) {
      monitor = { source: null, track: null, dest: audioCtx!.createMediaStreamDestination(), analyser: audioCtx!.createAnalyser() };
      monitor.analyser.fftSize = 32768; // the dev hook's level: most of a second, so a short beep from a fake microphone is not missed
      followMonitor();
    }
    return monitor.dest.stream;
  }
  function followMonitor(): void {
    if (!monitor) return;
    monitor.source?.disconnect();
    monitor.track = sentVoice;
    monitor.source = sentVoice ? audioCtx!.createMediaStreamSource(new MediaStream([sentVoice])) : null;
    monitor.source?.connect(monitor.dest);
    monitor.source?.connect(monitor.analyser);
  }
  function stopTestMedia(): void {
    testMedia++;
    clearTimeout(recordTimer);
    const r = recorder;
    recorder = null; // a recording stopped here is dropped, see its onstop
    if (r && r.state !== 'inactive') r.stop();
    testOut.onended = null;
    testOut.pause();
    testOut.srcObject = null;
    testOut.removeAttribute('src');
    monitor?.source?.disconnect();
    monitor?.dest.stream.getTracks().forEach((t) => t.stop());
    monitor = null;
  }
  const canTest = (): boolean => joined && !!voiceTrack && !!audioCtx;
  /** Takes me out of the call for the test: friends get silence and see me muted, I hear nobody. One thing plays or records at a time. */
  function cutCall(phase: MicTest): void {
    stopTestMedia();
    if (testing) { setTesting(phase); return; }
    testStarted = Date.now(); testChanges = 0; testRecordings = 0; testUsedLive = false;
    setTesting(phase);
    if (voiceTrack) voiceTrack.enabled = true;
    if (voice) { voice.track.enabled = true; voice.resume(); }
    void sendVoice();
    for (const p of peers.values()) applyGain(p);
    if (!untrack(muted)) room.send({ t: 'mute', muted: true });
    if (audioCtx?.state === 'suspended') void audioCtx.resume().catch(() => {});
  }
  function playTest(src: { stream: MediaStream } | { url: string }): void {
    if ('stream' in src) testOut.srcObject = src.stream; else testOut.src = src.url;
    void applySink(testOut);
    const media = testMedia;
    testOut.play().catch(() => { if (media === testMedia) stopMicTest('failed'); });
  }
  /** Hear my voice as friends would get it, live, while the settings change. */
  function hearYourself(): void {
    if (!canTest()) return;
    cutCall('live');
    testUsedLive = true;
    playTest({ stream: monitorStream() });
  }
  /** Record MIC_TEST_RECORD_MS of my voice as friends would get it, then play it back. */
  function recordMicTest(): void {
    if (!canTest() || typeof MediaRecorder === 'undefined') return;
    cutCall('recording');
    testRecordings++;
    const r = new MediaRecorder(monitorStream());
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      if (recorder !== r) return; // cancelled
      recorder = null;
      if (clip) URL.revokeObjectURL(clip);
      clip = URL.createObjectURL(new Blob(chunks, { type: r.mimeType }));
      setHasClip(true);
      playMicTest();
    };
    recorder = r;
    r.start();
    recordTimer = setTimeout(() => r.stop(), MIC_TEST_RECORD_MS);
  }
  /** Play the last recording; the test ends when it has played. */
  function playMicTest(): void {
    if (!joined || !clip) return;
    cutCall('playing');
    testOut.onended = () => stopMicTest('played');
    playTest({ url: clip });
  }
  /** Ends a test and puts the call back as it was; `mutedAfter` is the state Mute or Unmute is about to set, so friends see no flicker. */
  function stopMicTest(end: MicTestEnd = 'stop', mutedAfter = untrack(muted)): void {
    if (!testing) return;
    stopTestMedia();
    setTesting(null);
    if (voiceTrack) voiceTrack.enabled = !mutedAfter;
    if (voice) voice.track.enabled = !mutedAfter;
    void sendVoice();
    for (const p of peers.values()) applyGain(p);
    if (joined && !mutedAfter) room.send({ t: 'mute', muted: false });
    posthog.capture('mic_test', {
      end, seconds: Math.round((Date.now() - testStarted) / 1000), live: testUsedLive, recordings: testRecordings, changes: testChanges, noise_removal: untrack(noiseRemoval),
    });
  }
  /** A phone put away mid-test would leave me silent and deaf in the call. */
  const onTestHidden = () => { if (document.hidden) stopMicTest('hidden'); };
  document.addEventListener('visibilitychange', onTestHidden);

  // ---- the sent voice against the clock (ticket 37)
  /** Audio the track has handed on so far, ms, where the browser counts it (Chromium's MediaStreamTrack stats). */
  const deliveredMs = (t: MediaStreamTrack | null): number | null => {
    const v = (t as (MediaStreamTrack & { stats?: { deliveredFramesDuration?: number } }) | null)?.stats?.deliveredFramesDuration;
    return typeof v === 'number' ? v : null;
  };
  let guard = createVoiceGuard('context');
  /** The e2e suite's stand-ins for a device whose voice runs off real time, and for a worker that cannot keep up (hook only). */
  let clockSkew = 1;
  let loadOverride: Partial<VoiceLoad> = {};
  /** The start of the current `voice_send` window, and the track it measures. */
  let sendMark: (ClockSample & { track: MediaStreamTrack }) | null = null;
  let sendLoads: VoiceLoad[] = [];
  /**
   * Once a second while in a call with a friend: the processed voice goes to the guard, which stops noise removal when
   * it runs off real time or the device cannot keep up; every 30 s `voice_send` says how the voice I send keeps time.
   */
  function clockTick(): void {
    const track = sentVoice;
    const audioMs = deliveredMs(track);
    // Muted, a track delivers nothing: neither the guard nor `voice_send` measures that time.
    if (!joined || !track || audioMs === null || peers.size === 0 || !micLive()) { guard.reset(); sendMark = null; return; }
    const fresh = loadFresh;
    loadFresh = false;
    const now: ClockSample = { at: Date.now(), audioMs: audioMs * clockSkew, loadPct: voiceLoad?.pct, droppedMs: voiceLoad?.droppedMs };
    const processed = !!voice && track === voice.track;
    if (processed) {
      // The worklet path is judged by the clock, every tick; the worker path by the worker's readings, each one once.
      const fault = voice!.path === 'context' || fresh ? guard.feed(now) : null;
      if (fault) {
        removalFailed(fault.reason, { path: voice!.path, rate_pct: fault.ratePct, load_pct: fault.loadPct, dropped_ms: fault.droppedMs, mic_rate: voiceTrack?.getSettings().sampleRate ?? null });
        setNoiseRemovalStop(fault.reason);
        return;
      }
      if (voiceLoad !== null && fresh) sendLoads.push(voiceLoad);
    } else guard.reset();
    if (!sendMark || sendMark.track !== track) { sendMark = { ...now, track }; sendLoads = []; return; }
    if (now.at - sendMark.at < VOICE_SEND_EVERY_MS) return;
    posthog.capture('voice_send', {
      rate_pct: sendRatePct(sendMark, now), seconds: Math.round((now.at - sendMark.at) / 1000),
      noise_removal: untrack(noiseRemoval), path: processed ? voice!.path : null,
      load_pct: sendLoads.length ? Math.round(sendLoads.reduce((a, l) => a + l.pct, 0) / sendLoads.length) : null,
      load_max_pct: sendLoads.length ? Math.max(...sendLoads.map((l) => l.pct)) : null,
      dropped_ms: sendLoads.length ? sendLoads.reduce((a, l) => a + l.droppedMs, 0) : null,
      mic_rate: voiceTrack?.getSettings().sampleRate ?? null, peers: peers.size,
    });
    sendMark = { ...now, track };
    sendLoads = [];
  }
  const clockTimer = setInterval(clockTick, 1000);

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

  /**
   * A friend's voice waits at least LOW_VOICE_BUFFER_MS while either of us asks for low bandwidth voice (ticket 28), and
   * at least what the buffer that follows the line asks for (ticket 34); the larger of the two.
   */
  function applyVoiceBuffer(peer: Peer): void {
    const receiver = peer.pc.getTransceivers()[SLOT_INDEX.voice]?.receiver;
    if (!receiver) return;
    const ms = Math.max(lowVoiceOn || peer.asksLowVoice ? LOW_VOICE_BUFFER_MS : 0, bufferMs(peer.buffer) ?? 0) || null;
    const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
    try { if (r.jitterBufferTarget !== ms) r.jitterBufferTarget = ms; } catch { /* unsupported */ }
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
  /** For what changes the microphone's constraints outside the settings: noise removal giving up, the live mic test. */
  function queueMicSync(): void {
    audioChain = audioChain.then(() => syncMicrophone()).catch((e) => console.warn('microphone sync', e));
  }
  async function changeAudioNow(change: Partial<AudioSettings>): Promise<void> {
    const prev = audioSettings();
    const next = { ...prev, ...change };
    if (testing) testChanges++;
    if (voiceTrack && next.microphoneId !== prev.microphoneId) {
      storeAudioSettings(next); // the id is selected now; rolled back if the capture fails: the old microphone stays live and selected
      if (!(await reopenMicrophone(microphoneConstraints(next)))) { storeAudioSettings(prev); return; }
    } else {
      storeAudioSettings(next);
      if (next.noiseRemoval !== prev.noiseRemoval) {
        removalUnavailable = false; // switching it on again tries again
        setNoiseRemovalStop(null);
        if (next.noiseRemoval) void startNoiseRemoval(next); else stopNoiseRemoval();
      }
      if (next.voiceThreshold !== prev.voiceThreshold) voice?.setThreshold(next.voiceThreshold);
      await syncMicrophone(next); // echo cancellation, noise suppression and automatic gain, live

    }
    if (next.speakerId !== prev.speakerId) {
      for (const p of peers.values()) { void applySink(p.audio); void applySink(p.shareAudio); }
      void applySink(testOut);
    }
    if (next.masterVolume !== prev.masterVolume) for (const p of peers.values()) applyGain(p, next.masterVolume);
    if (next.lowBandwidthVoice !== lowVoiceOn) {
      lowVoiceOn = next.lowBandwidthVoice;
      posthog.capture('low_bandwidth_voice_toggled', { on: lowVoiceOn, peers: peers.size });
      for (const p of peers.values()) { applyVoiceBuffer(p); renegotiateVoice(p); }
    }
    if (next.voiceRepair !== voiceRepair) {
      voiceRepair = next.voiceRepair;
      posthog.capture('voice_repair_changed', { mode: voiceRepair, peers: peers.size });
      for (const p of peers.values()) renegotiateVoice(p);
    }
  }

  /** What a participant's gain nodes are set to: the master volume times their own local volume; nothing during a mic test. */
  const effectiveGain = (peer: Peer, master = untrack(audioSettings).masterVolume): number => (testing ? 0 : master * peer.view.volume);
  function applyGain(peer: Peer, master?: number): void {
    const g = effectiveGain(peer, master);
    if (peer.voiceGain) peer.voiceGain.gain.value = g;
    if (peer.shareGain) peer.shareGain.gain.value = g;
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
  const changeShare = (change: Partial<ShareSettings>) => setShareSettings(withChange(shareSettings(), change));

  /** Set how loud one participant is for me: their voice and share audio, nothing sent anywhere (ticket 08). */
  function setVolume(key: string, value: number): void {
    const v = clampVolume(value);
    const peer = peers.get(key);
    if (peer) {
      setView(peer, { volume: v });
      applyGain(peer);
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
    // While the processed voice goes out, my ring shows what friends hear: the gate being open. A mic test, nothing.
    const heard = !muted() && testing === null;
    setSpeakingSelf(voice && sentVoice === voice.track ? heard && lastLevel.open : loud('me', localAnalyser, heard));
    let changed = false;
    for (const p of peers.values()) {
      const s = loud(p.key, p.analyser, true);
      if (s !== p.view.speaking) { p.view.speaking = s; changed = true; }
    }
    if (changed) publish();
  }, 100);

  // ---- peers
  function createPeer(key: string, name: string, initiator: boolean): Peer {
    // After a stalled attempt the rebuild goes relay-only (ticket 22): ICE had found a direct path that never carried
    // encryption, so the retry avoids it. My relay candidates suffice; every pair then passes through the TURN server.
    const relayOnly = transportPolicyFor(stuckAttempts.get(key) ?? 0, hasTurn()) === 'relay';
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    const audio = new Audio();
    audio.autoplay = true;
    const keepAlive = new Audio();
    keepAlive.autoplay = true;
    keepAlive.muted = true;
    const { closed, close: markClosed } = closeLatch();
    const peer: Peer = {
      key, name, pc, closed, markClosed, polite: isPolite(myKey, key), tx: [], makingOffer: false, ignoreOffer: false, srdAnswerPending: false, audio, keepAlive, audioNodes: [], restarts: 0, relayOnly, generation: ++generation,
      view: { publicKey: key, name, conn: 'connecting', speaking: false, serverLost: false, audioBytesIn: 0, watching: false, shareLive: false, shareKbps: 0, shareFormat: null, volume: untrack(volumes)[key] ?? 1, rttMs: null },
      viewsMyShare: earlyViewers.has(key), viewerScale: earlyViewers.get(key) ?? 1, asksLowVoice: false, sendsRed: false, sendsFec: true, voiceLast: null, voiceReported: null, voiceSamples: 0, buffer: INITIAL_BUFFER, lastWindow: null, remoteShare: new MediaStream(), shareAudio: new Audio(), videoBytesIn: 0, videoBytesAt: 0, videoBytesOut: 0, outKbps: 0, outFormat: null, encodingChain: Promise.resolve(),
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
    pc.onnegotiationneeded = () => void offer(peer);
    pc.onicecandidate = ({ candidate }) => {
      peer.outgoingCandidates.push(candidate ? candidate.toJSON() : null);
      peer.candidateTimer ??= setTimeout(() => flushCandidates(peer), CANDIDATE_BATCH_MS);
    };
    pc.oniceconnectionstatechange = () => onIceState(peer);
    pc.onconnectionstatechange = () => onConnectionState(peer);
    armConnectWatchdog(peer, initiator);
    pc.ontrack = ({ track, transceiver }) => {
      // Fires inside setRemoteDescription, before the answerer has recorded its transceivers,
      // so identify the slot by position in the connection's transceiver list, not via peer.tx.
      const slot = pc.getTransceivers().indexOf(transceiver);
      if (track.kind === 'audio' && slot === SLOT_INDEX.voice) {
        wireRemoteAudio(peer, 'voice', new MediaStream([track]));
        applyVoiceBuffer(peer);
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
    // A rebuilt connection lost the sharer's subscription; re-assert mine before the first publish, so a tile that
    // was live never reads "closed" in between, which would end its fullscreen (spec §6.5, §8.1).
    if (watchIntent.has(key) && sendSubscribe(key, true)) peer.view.watching = true;
    publish();
    return peer;
  }

  /**
   * Remote audio path (ticket 08): raw track -> gain (master times per-participant volume, local only) -> a MediaStream that a
   * normal audio element plays, so speaker selection via setSinkId keeps working. The raw track also stays
   * attached to a muted element, which Chrome requires before it feeds remote audio into WebAudio at all.
   */
  function wireRemoteAudio(peer: Peer, kind: 'voice' | 'share', stream: MediaStream): void {
    const out = kind === 'voice' ? peer.audio : peer.shareAudio;
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (kind === 'voice') { peer.keepAlive.srcObject = stream; peer.keepAlive.play().catch(refused); }
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = effectiveGain(peer);
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
    out.play().catch(refused); // the join click, or on a Rejoin the live microphone, normally suffices
  }

  const refused = (e: unknown) => { if (e instanceof Error && e.name === 'NotAllowedError') setAudioBlocked(true); };
  /** The click behind "Click to hear the call": replay every remote element and resume the context inside the gesture. */
  function unblockAudio(): void {
    setAudioBlocked(false);
    void audioCtx?.resume().catch(() => {});
    voice?.resume();
    for (const p of peers.values()) for (const el of [p.keepAlive, p.audio, p.shareAudio]) if (el.srcObject) el.play().catch(refused);
  }

  function attachLocalTracks(peer: Peer): void {
    const voiceSender = peer.tx[SLOT_INDEX.voice]?.sender;
    const voiceOut = wireFor(outgoingVoice());
    if (voiceSender && voiceOut) voiceSender.replaceTrack(voiceOut).catch((e) => console.warn('replaceTrack voice', e));
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
  function applyShareEncoding(peer: Peer, staleRetries = 0): Promise<void> {
    peer.encodingChain = peer.encodingChain.then(() => applyShareEncodingNow(peer, staleRetries)).catch((e) => console.warn('setParameters share', e));
    return peer.encodingChain;
  }
  /** How often parameters changed underneath a setParameters are read again before giving up with a warning. */
  const STALE_PARAMETER_RETRIES = 5;
  async function applyShareEncodingNow(peer: Peer, staleRetries: number): Promise<void> {
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
      try {
        await sender.setParameters(params);
      } catch (e) {
        // A negotiation changed the sender between getParameters and setParameters (seen when a participant rejoins
        // mid-share, found by the e2e suite): read the parameters again shortly. A few times only, so an error that
        // keeps coming back ends in the usual warning instead of a silent loop.
        if ((e as DOMException).name !== 'InvalidModificationError' || staleRetries >= STALE_PARAMETER_RETRIES) throw e;
        setTimeout(() => void applyShareEncoding(peer, staleRetries + 1), 100);
        return;
      }
    }
  }

  /** Re-apply the budget split to every current Viewer when the viewer set changes. */
  function reapplyShareEncodings(): void {
    for (const p of peers.values()) if (p.viewsMyShare) void applyShareEncoding(p);
  }

  /** Perfect negotiation's offering side: on negotiationneeded, and when low bandwidth voice is switched. */
  async function offer(peer: Peer): Promise<void> {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      await sendDescription(peer);
    } catch (e) {
      console.warn('negotiationneeded failed', e);
    } finally {
      peer.makingOffer = false;
    }
  }

  /**
   * Low bandwidth voice switched mid-call (ticket 27): offer again, so the other side reads the new ask and its answer
   * reaches my encoder rewritten. A negotiation already under way is waited out; it carried the old setting.
   */
  function renegotiateVoice(peer: Peer): void {
    if (peers.get(peer.key) !== peer || peer.pc.connectionState === 'closed') return;
    if (peer.pc.signalingState !== 'stable' || peer.makingOffer) { setTimeout(() => renegotiateVoice(peer), 500); return; }
    void offer(peer);
  }

  /**
   * Send my current local description with its DTLS fingerprints signed by my identity key, bound to this peer (ADR 0004).
   * The copy sent asks for low bandwidth voice and the voice repair chosen here; my own connection keeps the description as the browser made it.
   */
  async function sendDescription(peer: Peer): Promise<void> {
    const own = peer.pc.localDescription;
    if (!own) return;
    const description = { type: own.type, sdp: voiceSdp(own.sdp) };
    const sig = await signDescription({ privateKey: identity.keys.privateKey, from: myKey, to: peer.key, sdp: description.sdp });
    if (!sig) {
      // Never happens with a real browser description; if it did, the other side would refuse it anyway.
      console.warn('local description carries no DTLS fingerprint; not sent');
      posthog.capture('signal_unsignable', { type: description.type });
      return;
    }
    room.send({ t: 'signal', to: peer.key, data: { description: { type: description.type, sdp: description.sdp }, sig } });
  }

  function flushCandidates(peer: Peer): void {
    peer.candidateTimer = undefined;
    if (!peer.outgoingCandidates.length) return;
    const candidates = peer.outgoingCandidates.splice(0, 64);
    if (candidates.some((c) => typeof (c as { candidate?: string } | null)?.candidate === 'string' && (c as { candidate: string }).candidate.includes(' relay '))) posthog.capture('relay_candidate_gathered');
    room.send({ t: 'signal', to: peer.key, data: { candidates } });
    if (peer.outgoingCandidates.length) peer.candidateTimer = setTimeout(() => flushCandidates(peer), 0);
  }

  /** Signals from one participant are applied in arrival order, one at a time, keyed by identity (core/signalchain.ts). */
  const signalChain = keyedChain((e) => console.warn('signal handling failed', e));
  const onSignal = (from: string, data: SignalData): void => void signalChain(from, () => onSignalNow(from, data));

  async function onSignalNow(from: string, data: SignalData): Promise<void> {
    if (!joined) return;
    const isOffer = (data.description as RTCSessionDescriptionInit | undefined)?.type === 'offer';
    if (data.description) {
      // The server only attributes this description to `from`; the signature proves that identity produced
      // the DTLS fingerprints inside it, for me (ADR 0004). Checked before anything is torn down or created.
      const verdict = await verifyDescription({ from, to: myKey, sdp: (data.description as RTCSessionDescriptionInit).sdp ?? '', signature: data.sig });
      if (verdict !== 'ok') {
        console.warn('description rejected:', verdict, 'from', peers.get(from)?.view.name ?? from.slice(0, 8));
        posthog.capture('signal_rejected', { reason: verdict, offer: isOffer });
        return;
      }
    }
    let peer = peers.get(from);
    if (peer && isOffer && (peer.view.serverLost || peer.pc.iceConnectionState === 'failed' || peer.pc.connectionState === 'closed'
      || isFreshConnection(peer.pc.remoteDescription?.sdp, (data.description as RTCSessionDescriptionInit).sdp ?? ''))) {
      // A fresh offer from a peer whose old connection is dead, who vanished and came back, or who built a new connection
      // (their watchdog or a rejoin, told by a new DTLS certificate, ticket 22): start over. Applying it to the old
      // connection would renegotiate a link the other side has already torn down.
      closePeer(from);
      peer = undefined;
    }
    if (!peer) {
      // Candidates come after the description they belong to, in order: without one they are left over from a
      // connection the sender has torn down (a reload served by the service worker is quick enough to meet them).
      if (!data.description) return;
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
        peer.asksLowVoice = asksLowVoice(description.sdp ?? '');
        // My encoder reads its bitrate, packet length, FEC flag and codec order from this description: rewritten, it obeys my settings too.
        const applied = { type: description.type, sdp: voiceSdp(description.sdp ?? '') };
        await unlessClosed(peer.closed, pc.setRemoteDescription(applied));
        peer.sendsRed = sendsRed(applied.sdp);
        peer.sendsFec = asksFec(applied.sdp);
        applyVoiceBuffer(peer); // they may have switched low bandwidth voice on or off
        peer.srdAnswerPending = false;
        if (description.type === 'offer') {
          if (peer.tx.length === 0) {
            // The answerer adopts the offered transceivers and makes them bidirectional before answering.
            peer.tx = pc.getTransceivers().slice(0, 3);
            for (const t of peer.tx) t.direction = 'sendrecv';
            attachLocalTracks(peer);
          }
          await unlessClosed(peer.closed, pc.setLocalDescription());
          await sendDescription(peer);
        }
      }
      if (data.candidates) {
        if (!pc.remoteDescription) return; // left over from their torn-down connection, as above
        for (const c of data.candidates) {
          try {
            await unlessClosed(peer.closed, pc.addIceCandidate((c as RTCIceCandidateInit | null) ?? undefined));
          } catch (e) {
            if (e === CLOSED || !peer.ignoreOffer) throw e;
          }
        }
      }
    } catch (e) {
      if (e === CLOSED) return; // closed on purpose; what follows belongs to the next connection
      console.warn('signal handling failed', e);
    }
  }

  /**
   * The badge turns green only on the full connection state, which includes the DTLS handshake. ICE alone
   * can succeed one-sidedly (the other side answered our checks but refused our description, ticket 14),
   * and a path without encryption carries no media; showing "direct" for it also silenced the watchdog.
   */
  function onConnectionState(peer: Peer): void {
    if (peer.pc.connectionState !== 'connected') return;
    clearTimeout(peer.connectTimer);
    stuckAttempts.delete(peer.key);
    if (peer.view.conn === 'connecting' || peer.view.conn === 'reconnecting' || peer.view.conn === 'unreachable') setView(peer, { conn: 'direct' });
    // Ask again now the link is up. The ask sent when this connection was built can reach the sharer while they still
    // hold the old one, which their fresh-offer path then closes along with the subscription (a Rejoin, a rebuild).
    // A repeated subscribe is harmless on the sharer's side.
    if (watchIntent.has(peer.key) && sendSubscribe(peer.key, true) && !peer.view.watching) setView(peer, { watching: true });
    void refreshStats(peer);
  }

  function onIceState(peer: Peer): void {
    const s = peer.pc.iceConnectionState;
    clearTimeout(peer.disconnectTimer);
    if (s === 'connected' || s === 'completed') {
      peer.restarts = 0;
      clearTimeout(peer.restartTimer);
      // After an ICE restart the connection state may already read connected; let it settle the badge.
      onConnectionState(peer);
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

  /** One peer as a problem report sees it: states, the share track, decoder and encoder counters, the selected pair (ticket 12). */
  async function peerDiag(peer: Peer): Promise<PeerDiagnostics> {
    const { inboundVideo, outboundVideo, inboundVoice, outboundVoice, pair } = await reportStats(peer.pc, peer.tx[SLOT_INDEX.voice]);
    const track = peer.remoteShare.getVideoTracks()[0];
    const { conn, watching, shareLive, shareKbps, shareFormat, serverLost, volume, rttMs } = peer.view;
    return {
      fingerprint: untrack(room.people).find((p) => p.publicKey === peer.key)?.fingerprint ?? null, polite: peer.polite, restarts: peer.restarts, relayOnly: peer.relayOnly, viewsMyShare: peer.viewsMyShare, viewerScale: peer.viewerScale, asksLowVoice: peer.asksLowVoice, sendsRed: peer.sendsRed, sendsFec: peer.sendsFec,
      voiceBufferMs: (peer.pc.getTransceivers()[SLOT_INDEX.voice]?.receiver as (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | undefined)?.jitterBufferTarget ?? null,
      voiceBuffer: { adaptiveMs: bufferMs(peer.buffer), level: peer.buffer.level, lastWindow: peer.lastWindow },
      view: { conn, watching, shareLive, shareKbps, shareFormat, serverLost, volume, rttMs },
      pc: { connection: peer.pc.connectionState, ice: peer.pc.iceConnectionState, signaling: peer.pc.signalingState, gathering: peer.pc.iceGatheringState, transceivers: peer.pc.getTransceivers().length },
      shareTrack: track ? { readyState: track.readyState, muted: track.muted } : null,
      inboundVideo, outboundVideo, inboundVoice, outboundVoice, pair,
    };
  }

  /** The voice receiver's cumulative counters, or null before their voice arrives or once the connection is closed. */
  async function readVoice(peer: Peer): Promise<VoiceCounters | null> {
    const receiver = peer.pc.getTransceivers()[SLOT_INDEX.voice]?.receiver;
    if (!receiver || peer.pc.connectionState === 'closed') return null;
    return voiceCounters(receiver);
  }
  const fingerprintOf = (peer: Peer) => untrack(room.people).find((p) => p.publicKey === peer.key)?.fingerprint ?? null;
  /**
   * Every VOICE_SAMPLE_MS per friend (ticket 34): the window since the last sample feeds the buffer that follows the
   * line, and every VOICE_REPORT_EVERY samples the window since the last event goes to PostHog as `voice_quality`, so a
   * stuttering voice is measured without anyone filing a report. Silence between samples (no packet) says nothing.
   */
  async function sampleVoice(peer: Peer): Promise<void> {
    const cur = await readVoice(peer);
    if (!cur || peers.get(peer.key) !== peer) return;
    if (peer.voiceLast) {
      const w = voiceWindow(peer.voiceLast, cur);
      if (w) {
        peer.lastWindow = w;
        const next = nextBuffer(peer.buffer, w);
        const changed = bufferMs(next) !== bufferMs(peer.buffer);
        peer.buffer = next;
        if (changed) {
          applyVoiceBuffer(peer);
          posthog.capture('voice_buffer_adapted', { peer: fingerprintOf(peer), adaptive_ms: bufferMs(next), ...windowProps(w) });
        }
      }
    }
    peer.voiceLast = cur;
    peer.voiceReported ??= cur;
    if (++peer.voiceSamples % VOICE_REPORT_EVERY === 0) {
      const w = voiceWindow(peer.voiceReported, cur);
      peer.voiceReported = cur;
      if (w) {
        const target = (peer.pc.getTransceivers()[SLOT_INDEX.voice]?.receiver as (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | undefined)?.jitterBufferTarget ?? null;
        posthog.capture('voice_quality', { peer: fingerprintOf(peer), conn: peer.view.conn, rtt_ms: peer.view.rttMs, buffer_target_ms: target, adaptive_ms: bufferMs(peer.buffer), low_voice: lowVoiceOn || peer.asksLowVoice, voice_repair: voiceRepair, sends_red: peer.sendsRed, sends_fec: peer.sendsFec, ...windowProps(w) });
      }
    }
  }
  const voiceTimer = setInterval(() => { for (const p of peers.values()) void sampleVoice(p); }, VOICE_SAMPLE_MS);

  /** Everything a problem report wants to know about the call (ticket 12). */
  async function diagnostics(): Promise<CallDiagnostics> {
    const { echoCancellation, noiseSuppression, autoGainControl, voiceThreshold } = untrack(audioSettings);
    return {
      inCall: joined, muted: untrack(muted), microphone: !!voiceTrack, micTest: testing, joinSeq: myJoinSeq,
      sharing: shareVideo ? { ...shareVideo.getSettings(), readyState: shareVideo.readyState, contentHint: shareVideo.contentHint } : null,
      outgoing: untrack(outgoing), shareSettings: untrack(shareSettings), viewerSettings: untrack(viewerSettings), audioProcessing: { echoCancellation, noiseSuppression, autoGainControl, noiseRemoval: untrack(noiseRemoval), voiceThreshold, path: voice?.path ?? null, stop: untrack(noiseRemovalStop), load: voiceLoad, micRate: voiceTrack?.getSettings().sampleRate ?? null }, lowBandwidthVoice: lowVoiceOn, voiceRepair,
      ice: { servers: iceServers.length, turn: hasTurn(), ageMinutes: iceIssuedAt ? Math.round((Date.now() - iceIssuedAt) / 60000) : null },
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
  function armConnectWatchdog(peer: Peer, initiator: boolean): void {
    const attempt = stuckAttempts.get(peer.key) ?? 0;
    peer.connectTimer = setTimeout(() => void connectWatchdog(peer, initiator, attempt), stuckDelay(attempt, initiator));
  }
  async function connectWatchdog(peer: Peer, initiator: boolean, attempt: number): Promise<void> {
    const stillStuck = () => peers.get(peer.key) === peer && peer.view.conn === 'connecting' && peer.pc.connectionState !== 'closed';
    if (!stillStuck()) return;
    const counts = await candidateCounts(peer.pc);
    posthog.capture('peer_connecting_slow', {
      attempt, initiator, polite: peer.polite, relay_only: peer.relayOnly, signaling: peer.pc.signalingState, ice: peer.pc.iceConnectionState, gathering: peer.pc.iceGatheringState,
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
    const { audioBytesIn, videoBytesIn, videoBytesOut, inFormat, outFormat, rttMs, relayed } = summarise(await peer.pc.getStats());
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
    if (rttMs !== peer.view.rttMs) setView(peer, { rttMs });
    if (relayed !== null && peer.pc.connectionState === 'connected' && peer.view.conn !== (relayed ? 'relayed' : 'direct')) setView(peer, { conn: relayed ? 'relayed' : 'direct' });
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
    peer.markClosed();
    peer.audio.srcObject = null;
    peer.shareAudio.srcObject = null;
    peer.keepAlive.srcObject = null;
    for (const n of peer.audioNodes) n.disconnect();
    sources.get(key)?.disconnect();
    sources.delete(key);
    peers.delete(key);
    // The signal chain stays: it is keyed by identity, and a restart from inside a handler (a fresh offer) must keep
    // the candidates behind that offer queued until setRemoteDescription on the new connection has finished (ticket 22).
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
        if (!p.sharing) { watchIntent.delete(p.publicKey); if (existing.view.watching) setView(existing, { watching: false, shareLive: false, shareKbps: 0, shareFormat: null }); }
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
        // The stalled-attempt count goes with them: a friend who comes back later gets a fresh first attempt on every path.
        stuckAttempts.delete(peer.key);
        if (ice === 'failed' || ice === 'closed' || ice === 'new') { closePeer(peer.key); continue; } // nothing worth keeping
        setView(peer, { serverLost: true });
        // A connection that works is kept however long their socket stays away (ticket 31): the voice never needed the
        // server. It ends when the browser says the link is gone (the disconnected and failed branches of onIceState),
        // or here, when it still is not up after the grace period.
        peer.graceTimer = setTimeout(() => graceEnded(peer), PEER_GRACE_MS);
      }
    }
  }
  function graceEnded(peer: Peer): void { if (peer.pc.connectionState !== 'connected') closePeer(peer.key); }
  createEffect(() => room.people(), (people) => { reconcile(people); }); // block body: never return a value from an effect callback

  // Re-declare after our own server reconnect (spec §8.1): peer connections stay, join sequence is fresh.
  createEffect(() => room.status().kind, (kind, prev) => {
    if (kind === 'connected' && prev !== undefined && prev !== 'connected' && joined) void redeclareAfterReconnect();
    if (kind === 'elsewhere' && joined) leave(); // another tab took over; this one is no longer in the call, and the marker goes
    if (kind === 'connected' && pendingRejoin) { const r = pendingRejoin; pendingRejoin = null; void join(r); }
  });

  /** Not a Rejoin: the page never reloaded, only the server socket came back. */
  async function redeclareAfterReconnect(): Promise<void> {
    const reply = await declareJoin();
    if (!reply) return;
    // Peers that kept their connection to us stay. Any connection that died while we were away is
    // rebuilt: we now hold the highest join sequence, so dropping it makes reconcile re-initiate.
    for (const peer of [...peers.values()]) {
      const s = peer.pc.iceConnectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') closePeer(peer.key);
    }
    reconcile(room.people());
    reassertSubscriptions(); // re-ask for any watched share the reconnect dropped (spec §6.5)
  }

  async function declareJoin(): Promise<Extract<ServerMessage, { t: 'call' }> | null> {
    const m = await awaitReply('call', () => room.send({ t: 'join', muted: muted() || !voiceTrack || testing !== null, sharing: shareVideo !== null }), 8000);
    if (m) { myJoinSeq = m.joinSeq; iceServers = m.iceServers; iceIssuedAt = m.issuedAt; }
    return m;
  }

  const unsubscribe = room.subscribe((m) => {
    switch (m.t) {
      case 'call': pending.get('call')?.(m); return;
      case 'ice': pending.get('ice')?.(m); return;
      case 'signal': onSignal(m.from, m.data); return;
      case 'left': watchIntent.delete(m.publicKey); stuckAttempts.delete(m.publicKey); closePeer(m.publicKey); return;
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

  /** Send one subscribe/unsubscribe frame; a small screen asks for a downscaled encoding (spec §6.4). Returns whether it reached the socket. */
  function sendSubscribe(key: string, on: boolean): boolean {
    return room.send(smallScreen() ? { t: 'subscribe', to: key, on, scale: 2 } : { t: 'subscribe', to: key, on });
  }

  /**
   * Re-assert my intent to watch one peer whose connection just (re)appeared. The sharer keeps each
   * subscription in memory only, so a rebuilt connection or a rejoin after a server reconnect drops it even
   * though the sharing flag survives; re-asking from my own intent brings the picture back without a click
   * (spec §6.5, §8.1). A peer already marked watching keeps a live subscription and is left untouched.
   */
  function assertWatch(peer: Peer): void {
    if (watchIntent.has(peer.key) && !peer.view.watching && sendSubscribe(peer.key, true)) setView(peer, { watching: true });
  }

  /** Re-ask for every share I still intend to watch, e.g. after a reconnect, so a picture live before does not stay dark. */
  function reassertSubscriptions(): void {
    for (const peer of peers.values()) assertWatch(peer);
  }

  /** Viewer side: ask the sharer to start or stop sending me their share. */
  function watch(key: string, on: boolean): void {
    const peer = peers.get(key);
    if (!peer || peer.view.watching === on) return;
    if (on) watchIntent.add(key); else watchIntent.delete(key);
    if (joined) writeRejoinMarker();
    const asked = sendSubscribe(key, on);
    posthog.capture('screen_watch_toggled', { watching: on, asked });
    // Show a watched tile only once the sharer has been asked. A frame dropped while the socket is down keeps
    // the intent and re-asserts on reconnect; until then the tile stays "click to watch" rather than promise a
    // picture nobody was asked for (spec §6.5). Stopping always takes effect at once.
    if (on && !asked) return;
    setView(peer, { watching: on, shareKbps: 0, shareFormat: null });
  }

  /** Fullscreen on one share unsubscribes every other (spec §6.5); leaving fullscreen does nothing. */
  function watchOnly(key: string): void {
    for (const p of peers.values()) if (p.key !== key && p.view.watching) watch(p.key, false);
    watch(key, true);
  }

  const shareStreamOf = (key: string): MediaStream | undefined => shareStreams().get(key);

  // ---- actions
  let joining = false;
  /** Join from the button, or as a Rejoin from the marker a reload left behind: the same steps without the click. */
  async function join(rejoin?: RejoinMarker): Promise<void> {
    if (joined || joining) return;
    joining = true;
    setJoinError(null);
    setMicProblem(null);
    try {
      try {
        await openMicrophone(); // first: a live capture is what lets the audio below start without a gesture
      } catch (e) {
        // No microphone, or none allowed: join anyway, to listen. The join click lets the call's sound play; a Rejoin may need one.
        setMicProblem(micProblemOf(e));
        posthog.capture('microphone_unavailable', { error: e instanceof Error ? e.name : 'unknown', rejoin: !!rejoin });
        audioCtx ??= new AudioContext();
        if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
      }
      if (rejoin) tryUnlockSound();
      const reply = await declareJoin();
      if (!reply) { setJoinError('The server did not answer the join request.'); posthog.capture('join_error', { reason: 'server_no_answer' }); return; }
      if (rejoin) {
        // Watched shares come back: intents set before reconcile builds the connections are subscribed as each one appears.
        // Only for friends still sharing, or a later share of theirs would start flowing to me without a click.
        const sharing = new Set(untrack(room.people).filter((p) => p.sharing).map((p) => p.publicKey));
        for (const key of rejoin.watching) if (sharing.has(key)) watchIntent.add(key);
        if (audioCtx?.state === 'suspended') setAudioBlocked(true);
      }
      setInCall(true);
      writeRejoinMarker();
      heartbeat = setInterval(writeRejoinMarker, REJOIN_HEARTBEAT_MS);
      exposeDevHook();
      posthog.capture('call_joined', { rejoin: !!rejoin, microphone: !!voiceTrack });
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
    stuckAttempts.clear();
    watchIntent.clear(); // joining again starts with every tile at "click to watch", not with yesterday's subscriptions
    clearInterval(heartbeat);
    local.remove(REJOIN_KEY); // a deliberate Leave (or another tab taking over) means no Rejoin
    setAudioBlocked(false);
    setInCall(false);
    myJoinSeq = null;
    setMicProblem(null);
    closeMicrophone();
  }

  function closeMicrophone(): void {
    stopMicTest('leave');
    if (clip) URL.revokeObjectURL(clip);
    clip = null;
    setHasClip(false);
    stopNoiseRemoval();
    sentVoice = null;
    wiredVoice = null;
    voiceTrack?.stop();
    localStream?.getTracks().forEach((t) => t.stop());
    sources.get('me')?.disconnect(); sources.delete('me');
    voiceTrack = null; localStream = null; localAnalyser = null;
    setSpeakingSelf(false);
  }

  /** Unmute in a call without a microphone: ask for one again, inside the click. */
  let micRetry = false;
  async function retryMicrophone(): Promise<boolean> {
    if (micRetry) return false;
    micRetry = true;
    try {
      await openMicrophone();
    } catch (e) {
      setMicProblem(micProblemOf(e));
      return false;
    } finally {
      micRetry = false;
    }
    if (!joined) { closeMicrophone(); return false; } // left while the browser asked
    setMicProblem(null);
    posthog.capture('microphone_opened_later');
    return true;
  }

  async function setMuted(m: boolean): Promise<void> {
    stopMicTest('mute', m);
    if (!m && joined && !voiceTrack && !(await retryMicrophone())) return;
    setMutedSignal(m);
    local.set('muted', String(m));
    if (voiceTrack) voiceTrack.enabled = !m;
    if (voice) voice.track.enabled = !m;
    if (joined) room.send({ t: 'mute', muted: m });
    posthog.capture('mute_toggled', { muted: m });
  }

  onCleanup(() => {
    unsubscribe();
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onTestHidden);
    clearInterval(statsTimer);
    clearInterval(voiceTimer);
    clearInterval(clockTimer);
    clearInterval(speakingTimer);
    leave();
    silent?.stop();
    audioCtx?.close();
  });

  // Inspection hook for the Playwright suite (e2e/) and the dev server. Absent in the builds friends get.
  // Every room has a call object; the hook follows the one you joined last.
  const exposeDevHook = () => {
    if (!exposeHooks) return;
    (window as unknown as { __dave?: unknown }).__dave = {
      peers: () => [...peers.values()].map((p) => ({ name: p.name, ice: p.pc.iceConnectionState, conn: p.view.conn, relayOnly: p.relayOnly, generation: p.generation, stuck: stuckAttempts.get(p.key) ?? 0, audioBytesIn: p.view.audioBytesIn, videoBytesIn: p.videoBytesIn, watching: p.view.watching, shareLive: p.view.shareLive, subscribedToMe: p.viewsMyShare, transceivers: p.pc.getTransceivers().length, rttMs: p.view.rttMs, asksLowVoice: p.asksLowVoice, sendsRed: p.sendsRed,
        voiceBufferMs: (p.pc.getTransceivers()[SLOT_INDEX.voice]?.receiver as (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | undefined)?.jitterBufferTarget ?? null, adaptiveMs: bufferMs(p.buffer), lastWindow: p.lastWindow })),
      share: () => untrack(() => ({
        settings: shareSettings(),
        outgoing: outgoing(),
        track: shareVideo ? { ...shareVideo.getSettings(), contentHint: shareVideo.contentHint } : null,
        senders: [...peers.values()].map((p) => { const params = p.tx[SLOT_INDEX.shareVideo]?.sender.getParameters(); const e = params?.encodings?.[0]; return { name: p.name, active: e?.active, maxBitrate: e?.maxBitrate, maxFramerate: e?.maxFramerate, scale: e?.scaleResolutionDownBy, degradation: (params as { degradationPreference?: string } | undefined)?.degradationPreference }; }),
      })),
      audio: () => untrack(() => ({
        settings: audioSettings(), track: voiceTrack?.getSettings() ?? null, noiseRemoval: noiseRemoval(), path: voice?.path ?? null, stop: noiseRemovalStop(), load: voiceLoad, deliveredMs: deliveredMs(sentVoice),
        sending: !sentVoice ? null : sentVoice === voice?.track ? 'processed' : 'microphone', level: lastLevel,
      })),
      micTest: () => ({
        phase: testing, clip: !!clip, playing: !testOut.paused, sink: (testOut as HTMLAudioElement & { sinkId?: string }).sinkId ?? '',
        follows: !monitor?.track ? null : monitor.track === voice?.track ? 'processed' : 'microphone', level: monitor ? levelOf(monitor.analyser) : null, wire: !wiredVoice ? null : wiredVoice === silent ? 'silence' : 'voice',
      }),
      /** The last recording decoded: how long, and how loud at its loudest 100 ms. */
      micTestClip: async () => {
        if (!clip || !audioCtx) return null;
        const buf = await audioCtx.decodeAudioData(await (await fetch(clip)).arrayBuffer());
        const data = buf.getChannelData(0), step = Math.round(buf.sampleRate / 10);
        let peak = 0;
        for (let i = 0; i + step <= data.length; i += step) { let sum = 0; for (let j = i; j < i + step; j++) sum += data[j]! * data[j]!; peak = Math.max(peak, Math.sqrt(sum / step)); }
        return { seconds: buf.duration, peak };
      },
      playback: () => untrack(() => ({ context: audioCtx?.state ?? null, blocked: audioBlocked(), paused: [...peers.values()].map((p) => ({ name: p.name, voice: p.audio.paused, keepAlive: p.keepAlive.paused })) })),
      volumes: () => ({ master: untrack(audioSettings).masterVolume, peers: [...peers.values()].map((p) => ({ name: p.name, voiceGain: p.voiceGain?.gain.value ?? null, shareGain: p.shareGain?.gain.value ?? null, view: p.view.volume, sink: (p.audio as HTMLAudioElement & { sinkId?: string }).sinkId ?? '' })) }),
      dropSocket: () => room.dropSocket(),
      /** What the stuck-connecting watchdog does, on demand (ticket 22): tear the connection to `name` down and offer again from a fresh one; `stalled` attempts already counted make the rebuild relay-only. */
      rebuild: (name: string, stalled = 0) => {
        const peer = [...peers.values()].find((p) => p.name === name);
        if (!peer) return 'no such peer';
        closePeer(peer.key);
        stuckAttempts.set(peer.key, stalled);
        createPeer(peer.key, peer.name, true);
        return `rebuilt ${name}, relayOnly=${peers.get(peer.key)?.relayOnly}`;
      },
      /** The end of the grace period for a friend who lost the server (ticket 31), on demand instead of after PEER_GRACE_MS: 'kept' or 'closed'. */
      expireGrace: (name: string) => {
        const peer = [...peers.values()].find((p) => p.name === name);
        if (!peer?.view.serverLost) return 'not lost';
        clearTimeout(peer.graceTimer);
        graceEnded(peer);
        return peers.has(peer.key) ? 'kept' : 'closed';
      },
      /** Makes the sent voice read `factor` of real time from now on, as a USB-C headset did (ticket 37). */
      skewVoiceClock: (factor: number) => { clockSkew = factor; },
      /** Makes the worker's readings say it loses frames (or carries a load) from now on (ticket 37 follow-up); `{}` stops it. */
      strainVoice: (load: Partial<VoiceLoad>) => { loadOverride = load; },
      diagnostics,
      state: () => ({ inCall: joined, joining, joinError: untrack(joinError), myJoinSeq, role: untrack(me)?.role ?? null, participants: untrack(room.people).filter((p) => p.role === 'participant').map((p) => `${p.name}#${p.joinSeq}`) }),
    };
  };
  exposeDevHook();

  return {
    inCall, muted: () => muted() || micProblem() !== null, micProblem, views, speakingSelf, joinError, join: () => join(), leave, setMuted, myJoinSeq: () => myJoinSeq, audioBlocked, unblockAudio,
    noiseRemoval, noiseRemovalStop, voiceLevel,
    micTest, hasMicTestClip: hasClip, canRecordMicTest: typeof MediaRecorder !== 'undefined', hearYourself, recordMicTest, playMicTest, stopMicTest,
    sharing, shareError, outgoing, startShare, stopShare, watch, watchOnly, shareStreamOf,
    shareSettings, changeShare, audioSettings, changeAudio, viewerSettings, setViewerSettings, devices, refreshDevices, canPickSpeaker,
    setVolume, canPickSpeakerDialog, pickSpeaker,
    diagnostics, reportBlackShare,
  };
}
