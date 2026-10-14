import { createEffect, createSignal, onCleanup } from 'solid-js';
import posthog, { onConsentChange, telemetryOn } from './posthog';
import { buildAuthMessage } from '../core/identity';
import {
  CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, PING_FRAME, PING_INTERVAL_MS,
  type ClientMessage, type Identity, type Person, type RequestId, type ServerMessage,
} from '../core/protocol';
import {
  afterJoin, afterWelcome, carried, declare, declared, forgetEnded, forgetWatch, inCallOnly, joinDeclares, leaveCall,
  type Carried, type Declaration,
} from '../core/declarations';
import { beat, heard, heartbeat } from '../core/heartbeat';
import type { LocalIdentity } from './identity';
import { appendHistory, clearHistory, loadHistory, textKey, type StoredText } from './history';

export type ServerStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'unavailable'; since: number }
  | { kind: 'refused'; reason: string }
  /** Another tab or window of this browser opened the room; this one stepped back (close code 4004). */
  | { kind: 'elsewhere' };

export type ChatLine =
  | { kind: 'text'; id: string; from: Identity; text: string; at: number }
  | { kind: 'system'; id: string; text: string; at: number };

const UNAVAILABLE_AFTER_MS = 30_000;
/** Texts shown remembered by writer and id, to show a text sent again only once (ticket 51); the oldest are forgotten. */
const SEEN_TEXTS_MAX = 1000;
const BACKOFF_MAX_MS = 30_000;
/**
 * A socket the server has not let in after this long is given up and tried again. The upgrade or the handshake can hang
 * on the way to the Room, and no close comes for it: the app sat on "Connecting…" for good (nightly, ticket 48). The
 * server gives an answer to its challenge as long.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** What a handshake given up is reported as (no close event says it). */
const HANDSHAKE_GIVEN_UP = 4008;
/** What a socket given up for its unanswered pings (core/heartbeat.ts) is closed with, and reported as. */
const PINGS_UNANSWERED = 4009;

/**
 * The client's view of one Room: one WebSocket with the challenge handshake,
 * reconnection with exponential backoff (spec §8.1), presence snapshots, and
 * ephemeral text. The call (WebRTC) is layered on top by createCall.
 */
export function createRoom(opts: { identity: LocalIdentity; roomId: string; authKey: string; name: string; picture: string | null; hold?: () => boolean }) {
  /**
   * The latest of everything this friend declares (core/declarations.ts): the auth of every socket carries her name,
   * picture and opt-in, the welcome is followed by what changed meanwhile, her join by what she declared in the call.
   */
  const latest = declared(opts.name, opts.picture, telemetryOn());
  const [status, setStatus] = createSignal<ServerStatus>({ kind: 'connecting' });
  const [you, setYou] = createSignal<Person | null>(null);
  const [people, setPeople] = createSignal<Person[]>([]);
  const [lines, setLines] = createSignal<ChatLine[]>([]);
  /** Texts from others that arrived live while this room was not the one on screen. */
  const [unread, setUnread] = createSignal(0);
  const listeners = new Set<(m: ServerMessage) => void>();
  const textListeners = new Set<(m: Extract<ServerMessage, { t: 'text' }>) => void>();
  let nextId = 1;
  /**
   * Own texts not back from the Room yet, oldest first. The network can drop a socket under a text (1006, the Room none the
   * wiser), and the text was gone for everyone: each is sent again on the next socket, until it comes back or is refused.
   */
  const unconfirmed: Array<{ id: string; text: string }> = [];
  /** `publicKey:id` of the texts shown, oldest first: one sent again may have reached us the first time. */
  const seenTexts = new Set<string>();
  // Recent history from this browser, loaded once; live lines append after it.
  const fromStored = (m: StoredText): ChatLine => ({ kind: 'text', id: textKey(m), ...m });
  void loadHistory(opts.roomId).then((stored) => setLines((l) => [...stored.map(fromStored), ...l]));
  const push = (line: { kind: 'text'; id: string; from: Identity; text: string; at: number } | { kind: 'system'; text: string; at: number }) =>
    setLines((l) => [...l, 'id' in line ? (line as ChatLine) : ({ ...line, id: `sys-${nextId++}` } as ChatLine)]);
  let ws: WebSocket | null = null;
  /** The socket the server has let in (its welcome came), and how many sockets it has let in so far. */
  let welcomed: WebSocket | null = null;
  let welcomes = 0;
  let attempt = 0;
  let downSince: number | null = null;
  let everConnected = false;
  /** What the last auth carried. */
  let authCarried: Carried | null = null;
  /** `welcomes` when the join went out: the Room has this friend in its call on that socket, until her leave. */
  let callOn: number | null = null;
  const inCall = (): boolean => welcomed !== null && callOn === welcomes;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Write a frame if the socket is open and let in; returns whether it went out, so a caller can re-assert what was dropped.
   * Before the welcome the server takes any frame but the auth for a stranger's, and its error for a wrong invite link.
   */
  const send = (m: ClientMessage): boolean => {
    if (ws?.readyState !== WebSocket.OPEN || welcomed !== ws) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  /**
   * Declares something anew (core/declarations.ts): the latest value is kept, and goes out on every socket from now on.
   * Returns whether it went out now; one that did not goes out once the Room lets this friend in again (or in its call
   * again, for what only a friend in the call declares).
   */
  function declareLatest(d: Declaration): boolean {
    declare(latest, d);
    return (!inCallOnly(d) || inCall()) && send(d);
  }

  function open() {
    if (stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/${opts.roomId}`);
    ws = socket;
    /** Gives the socket up: its close could come late or never, with a server or a network that does not answer. */
    const giveUp = (code: number) => {
      socket.onopen = socket.onmessage = socket.onclose = null;
      if (code === HANDSHAKE_GIVEN_UP) socket.close();
      else socket.close(code, 'pings unanswered');
      lost(socket, code);
    };
    const handshake = setTimeout(() => {
      if (ws !== socket || welcomed === socket || stopped) return;
      giveUp(HANDSHAKE_GIVEN_UP);
    }, HANDSHAKE_TIMEOUT_MS);
    const beats = heartbeat(Date.now());

    socket.onopen = () => {
      pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // A socket the network cut without a close (ticket 54) would otherwise look open for good, its texts gone into it.
        if (beat(beats, Date.now()) === 'ping') socket.send(PING_FRAME);
        else giveUp(PINGS_UNANSWERED);
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = async (e) => {
      heard(beats);
      const m = JSON.parse(e.data as string) as ServerMessage;
      switch (m.t) {
        case 'challenge': {
          const { name, picture, telemetry } = carried(latest);
          const auth = await buildAuthMessage({
            authKey: opts.authKey, nonce: m.nonce, publicKeyRaw: opts.identity.publicKeyRaw, privateKey: opts.identity.keys.privateKey, name, ...(picture ? { picture } : {}),
          });
          // Nobody has entered this room yet: our answer also hands the server the verifier (ADR 0004). The PostHog
          // opt-in rides along, so the server reports this socket's refused frames only with consent (ticket 32).
          // Closed while signing (the page reloading, another tab taking over): nothing to answer.
          if (socket.readyState !== WebSocket.OPEN) return;
          authCarried = { name, picture, telemetry };
          socket.send(JSON.stringify({ ...auth, ...(m.fresh ? { authKey: opts.authKey } : {}), ...(telemetry ? { telemetry: true } : {}) }));
          return;
        }
        case 'welcome':
          clearTimeout(handshake);
          welcomed = socket;
          welcomes++;
          attempt = 0;
          setYou(m.you);
          // A rename, a picture or an opt-in changed while the handshake ran went to no socket; the auth had the old one.
          if (authCarried) for (const d of afterWelcome(latest, authCarried)) send(d);
          // Texts the last socket took and never brought back, in their order; the Room answers them in that order too.
          for (const u of unconfirmed) send({ t: 'text', text: u.text, id: u.id });
          setStatus({ kind: 'connected' });
          if (everConnected) {
            // No line in the chat about it: the status pill already shows the outage live, and dated lines that stayed
            // in the history piled up on flaky links (reports of Sep 16 and 20). A dead socket is only noticed when
            // a ping goes unanswered, so the gap sent here can be shorter than the real one.
            posthog.capture('server_reconnected', { down_ms: downSince ? Date.now() - downSince : 0 });
          }
          everConnected = true;
          downSince = null;
          clearTimeout(unavailableTimer);
          return;
        case 'presence':
          forgetEnded(latest, m.people);
          setPeople(m.people);
          return;
        case 'text': {
          if (m.id !== undefined) {
            const key = `${m.from.publicKey}:${m.id}`;
            if (seenTexts.has(key)) return;
            seenTexts.add(key);
            if (seenTexts.size > SEEN_TEXTS_MAX) seenTexts.delete(seenTexts.values().next().value!);
            if (m.from.publicKey === opts.identity.publicKey) {
              const i = unconfirmed.findIndex((u) => u.id === m.id);
              if (i >= 0) unconfirmed.splice(i, 1);
            }
          } else if (m.from.publicKey === opts.identity.publicKey) unconfirmed.shift(); // a Room from before ids: in order
          push({ kind: 'text', id: textKey(m), from: m.from, text: m.text, at: m.at });
          void appendHistory(opts.roomId, { from: m.from, text: m.text, at: m.at });
          if (m.from.publicKey !== opts.identity.publicKey) {
            setUnread((n) => n + 1);
            for (const l of textListeners) l(m);
          }
          return;
        }
        case 'error':
          if (you()) {
            // After the welcome an error means a frame of ours was dropped. Chat-related ones are said in the chat;
            // signaling ones, and any the server cannot attribute, are a developer concern and would only confuse in the
            // chat: an oversized signal once showed as "Not sent" (ticket 30).
            posthog.capture('frame_dropped', { ref: m.ref ?? 'unknown', reason: m.reason });
            if (!m.ref || m.ref === 'signal' || m.ref === 'ice') console.warn('dropped', m.ref ?? 'unknown', m.reason);
            else push({ kind: 'system', text: `${m.ref === 'text' ? 'Not sent' : 'Dropped'}: ${m.reason}.`, at: Date.now() });
            // The Room answers texts in the order they came: a refusal is for the oldest one still waiting. The chat said
            // it was not sent, so it is not sent again.
            if (m.ref === 'text') unconfirmed.shift();
          } else if (status().kind !== 'refused') {
            // A wrong answer during the handshake: our stored secret is wrong. Retrying cannot help.
            setStatus({ kind: 'refused', reason: m.reason });
            stopped = true;
            socket.close(1000, 'refused');
          }
          return;
        case 'pong':
          return;
        case 'call':
          // The Room has this friend in its call on this socket again: what she declared in it is said again, the asks
          // to watch a share among it. The answer goes on to the call (client/call.ts).
          if (socket === welcomed && inCall()) for (const d of afterJoin(latest, people())) send(d);
          break;
        case 'left':
          forgetWatch(latest, m.publicKey);
          break;
      }
      for (const l of listeners) l(m);
    };

    socket.onclose = (e) => { clearTimeout(handshake); lost(socket, e.code); };
  }

  /** A socket is gone, closed or given up: try again after a while, unless the close says that cannot help. */
  function lost(socket: WebSocket, code: number) {
    clearInterval(pingTimer);
    if (ws === socket) ws = null;
    if (welcomed === socket) welcomed = null;
    setYou(null);
    if (stopped) return;
    posthog.capture('server_socket_closed', { code, ever_connected: everConnected });
    if (code === CLOSE_SUPERSEDED) {
      stopped = true;
      // The room is another tab's now: a text still out would be sent when this one takes it back, maybe hours later.
      unconfirmed.length = 0;
      setStatus({ kind: 'elsewhere' });
      return;
    }
    if (code === CLOSE_AUTH_FAILED) {
      stopped = true;
      setStatus({ kind: 'refused', reason: 'the invite link is wrong or has been rotated' });
      return;
    }
    if (downSince === null) {
      downSince = Date.now();
      const since = downSince;
      // Escalate on a clock of its own, not only when a further attempt fails (spec §7.2).
      unavailableTimer = setTimeout(() => { if (downSince === since && !stopped) setStatus({ kind: 'unavailable', since }); }, UNAVAILABLE_AFTER_MS);
    }
    const down = Date.now() - downSince;
    setStatus(down >= UNAVAILABLE_AFTER_MS ? { kind: 'unavailable', since: downSince } : { kind: 'reconnecting', since: downSince });
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  // The first connection waits while `hold` says so: a new version downloading as the app opens (ticket 36) would only
  // show friends to take them away again with its reload, and they would see this browser come, go and come back.
  if (!opts.hold) open();
  else {
    let begun = false;
    createEffect(() => opts.hold!(), (held) => { if (!held && !begun) { begun = true; open(); } });
  }
  // Only once let in (`send`): before the welcome, any frame but the auth counts as a failed attempt, and the reply would
  // read as a refusal. A change during the handshake goes out with the welcome instead.
  const offConsent = onConsentChange((on) => { declareLatest({ t: 'telemetry', on }); });
  onCleanup(() => {
    offConsent();
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(unavailableTimer);
    clearInterval(pingTimer);
    ws?.close(1000, 'bye');
  });

  return {
    roomId: opts.roomId,
    status,
    you,
    people,
    lines,
    unread,
    /** The room is on screen: nothing in it is unread. */
    markRead: () => setUnread(0),
    /** Sends an event (a text, a signal, a request for ICE servers) on the socket let in, if there is one. */
    send,
    declare: declareLatest,
    /**
     * Enters the call on this socket. The join is an event (client/call.ts waits for its answer); what it declares, muted
     * and sharing, comes from the latest declarations. Returns whether it went out.
     */
    join: (id: RequestId): boolean => {
      if (!send({ t: 'join', ...joinDeclares(latest), id })) return false;
      callOn = welcomes;
      return true;
    },
    /** Leaves the call, if the Room has this friend in it on this socket; what she declared in the call ends with it. */
    leave: (): void => {
      if (inCall()) send({ t: 'leave' });
      callOn = null;
      leaveCall(latest);
    },
    /** The Room has this friend in its call on the socket let in: her join went out on it, and no leave since. */
    inCall,
    /** Counts the sockets the server has let in; read without waiting for any effect, so a frame can name its socket. */
    welcomes: () => welcomes,
    /** Sends a text; it shows when the Room brings it back. A socket lost meanwhile sends it again on the next one. */
    sendText: (text: string) => {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join(''); // not randomUUID: http on a LAN too
      unconfirmed.push({ id, text });
      send({ t: 'text', text, id });
      posthog.capture('message_sent');
    },
    /** Empties the local history; the server never had it. */
    clearHistory: async () => { await clearHistory(opts.roomId); setLines([]); },
    /** Dev aid for scripts/drive.mjs: drops the socket so the reconnect path runs. */
    dropSocket: () => ws?.close(),
    /** Change the name everyone sees; presence brings it back. A later reconnect authenticates with it too. */
    rename: (next: string) => { declareLatest({ t: 'name', name: next }); },
    /** Choose the emoji everyone sees as your avatar, or null for the initial; presence brings it back. */
    setPicture: (next: string | null) => { declareLatest({ t: 'picture', picture: next }); },
    /** After stepping back for another tab: reconnect here, which supersedes that tab in turn. */
    takeOver: () => { if (status().kind !== 'elsewhere') return; stopped = false; attempt = 0; downSince = null; setStatus({ kind: 'connecting' }); open(); },
    /** Fires for texts from other people (for the message cue). */
    onText: (l: (m: Extract<ServerMessage, { t: 'text' }>) => void) => { textListeners.add(l); return () => textListeners.delete(l); },
    /** Messages the room store does not handle itself (call, left, signal, ice) go to subscribers. */
    subscribe: (l: (m: ServerMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
}
