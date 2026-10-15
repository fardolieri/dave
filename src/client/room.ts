import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import posthog, { onConsentChange, telemetryOn } from './posthog';
import { buildAuthMessage } from '../core/identity';
import { openText, sealText } from '../core/sealed';
import {
  CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, MAX_TEXT_LENGTH, PING_FRAME, PING_INTERVAL_MS,
  type ClientMessage, type Identity, type Person, type RequestId, type ServerMessage, type TextId,
} from '../core/protocol';
import {
  afterJoin, afterWelcome, carried, declare, declared, forgetEnded, forgetWatch, inCallOnly, joinDeclares, leaveCall,
  type Carried, type Declaration,
} from '../core/declarations';
import { beat, heard, heartbeat } from '../core/heartbeat';
import { tooOld } from '../core/unsent';
import type { LocalIdentity } from './identity';
import { appendHistory, clearHistory, keepUnsent, loadHistory, loadUnsent, textKey, type StoredText } from './history';

export type ServerStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'unavailable'; since: number }
  | { kind: 'refused'; reason: string }
  /** Another tab or window of this browser opened the room; this one stepped back (close code 4004). */
  | { kind: 'elsewhere' };

export type ChatLine =
  /** `pending`: my own text the Room has not brought back yet; it waits at the end of the log, `at` my own clock's. */
  | { kind: 'text'; id: string; from: Identity; text: string; at: number; pending?: true }
  | { kind: 'system'; id: string; text: string; at: number };

/** A friend's text as opened: the Room relayed it sealed (ADR 0005). */
export type Text = { from: Identity; text: string; at: number; id: TextId };

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
/** Why this client gave a socket up itself, for `server_socket_closed`. */
const GIVEN_UP: Record<number, string> = { [HANDSHAKE_GIVEN_UP]: 'handshake_timeout', [PINGS_UNANSWERED]: 'pong_overdue' };
/** The sockets this tab holds, one per room it shows. */
const sockets = new Set<WebSocket>();
/** One socket's life, for `server_socket_closed`: when the Room let it in, when its last frame came. */
type Life = { welcomedAt: number | null; frameAt: number | null };

/**
 * The client's view of one Room: one WebSocket with the challenge handshake,
 * reconnection with exponential backoff (spec §8.1), presence snapshots, and
 * ephemeral text. The call (WebRTC) is layered on top by createCall.
 */
export function createRoom(opts: { identity: LocalIdentity; roomId: string; authKey: string; textKey: CryptoKey; name: string; picture: string | null; hold?: () => boolean }) {
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
  const textListeners = new Set<(m: Text) => void>();
  let nextId = 1;
  /**
   * Own texts not back from the Room yet, oldest first. The network can drop a socket under a text (1006, the Room none the
   * wiser), and the text was gone for everyone: each is sent again on the next socket, until it comes back or is refused.
   */
  const unconfirmed = loadUnsent(opts.roomId);
  /** `unconfirmed` as shown: after the lines, as waiting. */
  const [pending, setPending] = createSignal([...unconfirmed]);
  /** Drops the texts that waited too long to be sent, with a line saying so. */
  const dropTooOld = () => {
    const now = Date.now();
    const old = unconfirmed.filter((u) => tooOld(u, now));
    if (!old.length) return;
    unconfirmed.splice(0, unconfirmed.length, ...unconfirmed.filter((u) => !old.includes(u)));
    unconfirmedChanged();
    push({ kind: 'system', text: `Not sent: ${old.length === 1 ? 'a text' : `${old.length} texts`} written more than a day ago.`, at: now });
  };
  /** `unconfirmed` changed: it shows, and is kept for a reload, whose welcome sends it again (client/history.ts). */
  const unconfirmedChanged = (keep = true) => {
    setPending([...unconfirmed]);
    if (keep) keepUnsent(opts.roomId, unconfirmed);
  };
  /**
   * `publicKey:id` of the texts shown, oldest first: one sent again may have reached us the first time, before a reload of
   * ours too, so the history's ids count.
   */
  const seenTexts = new Set<string>();
  /** Whether a writer's text of this id was shown already; remembers it if not. */
  const seen = (publicKey: string, id: string): boolean => {
    const key = `${publicKey}:${id}`;
    if (seenTexts.has(key)) return true;
    seenTexts.add(key);
    if (seenTexts.size > SEEN_TEXTS_MAX) seenTexts.delete(seenTexts.values().next().value!);
    return false;
  };
  // Recent history from this browser, loaded once; live lines append after it.
  const fromStored = ({ from, text, at }: StoredText): ChatLine => ({ kind: 'text', id: textKey({ from, at }), from, text, at });
  void loadHistory(opts.roomId).then((stored) => {
    for (const m of stored) if (m.id !== undefined) seen(m.from.publicKey, m.id);
    setLines((l) => [...stored.map(fromStored), ...l]);
  });
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
   * Texts go out sealed (ADR 0005), in the order written: sealing takes a moment, and the Room answers texts in the order
   * they came. One sealed while there is no socket let in is not sent, and waits for the next welcome like any other.
   */
  let sealing: Promise<void> = Promise.resolve();
  const sendText = (u: { id: string; text: string }): void => {
    sealing = sealing.then(async () => {
      const sealed = await sealText({ key: opts.textKey, privateKey: opts.identity.keys.privateKey, roomId: opts.roomId, id: u.id, from: opts.identity.publicKey, text: u.text });
      send({ t: 'sealed', sealed, id: u.id });
    }).catch((e: unknown) => console.error('sealing a text failed', e));
  };
  /** Friends' texts are opened in the order the Room sent them, so they show in that order too. */
  let opening: Promise<void> = Promise.resolve();

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

  /**
   * A sealed text from the Room: shown and kept if it opens with the room's key and was signed by the friend the Room says
   * sent it. One that does not is dropped with a warning: only a server that tampers, or a client that cheats, sends one.
   */
  async function received(m: Extract<ServerMessage, { t: 'sealed' }>): Promise<void> {
    const opened = await openText({ key: opts.textKey, roomId: opts.roomId, id: m.id, from: m.from.publicKey, sealed: m.sealed });
    // A room forgotten or cleared meanwhile, or a tab that stepped back: nothing to show, and nothing to write back.
    if (stopped) return;
    const own = m.from.publicKey === opts.identity.publicKey;
    // My own text came back: the Room took it, whether or not it opens here, so sending it again cannot help.
    const i = own ? unconfirmed.findIndex((u) => u.id === m.id) : -1;
    if (i >= 0) { unconfirmed.splice(i, 1); unconfirmedChanged(); }
    if (!opened.ok) {
      // A server that reads or forges, or a friend's app that seals wrong: either is urgent, so the session briefing and the
      // night shift look for this event first (scripts/claude/session-start.sh). The writer by fingerprint only.
      console.warn(`text rejected: ${opened.reason}`);
      posthog.capture('text_rejected', { reason: opened.reason, writer: m.from.fingerprint, own, sealed_length: m.sealed.length });
      if (i >= 0) push({ kind: 'system', text: 'Not sent: your text came back unreadable.', at: Date.now() });
      return;
    }
    if (seen(m.from.publicKey, m.id)) return;
    const text: Text = { from: m.from, text: opened.text, at: m.at, id: m.id };
    push({ kind: 'text', id: textKey(text), from: text.from, text: text.text, at: text.at });
    void appendHistory(opts.roomId, text);
    if (!own) {
      setUnread((n) => n + 1);
      for (const l of textListeners) l(text);
    }
  }

  function open() {
    if (stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/${opts.roomId}`);
    ws = socket;
    sockets.add(socket);
    const life: Life = { welcomedAt: null, frameAt: null };
    /** Gives the socket up: its close could come late or never, with a server or a network that does not answer. */
    const giveUp = (code: number) => {
      socket.onopen = socket.onmessage = socket.onclose = null;
      if (code === HANDSHAKE_GIVEN_UP) socket.close();
      else socket.close(code, 'pings unanswered');
      lost(socket, code, life);
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
      life.frameAt = Date.now();
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
          life.welcomedAt = Date.now();
          welcomed = socket;
          welcomes++;
          attempt = 0;
          setYou(m.you);
          // A rename, a picture or an opt-in changed while the handshake ran went to no socket; the auth had the old one.
          if (authCarried) for (const d of afterWelcome(latest, authCarried)) send(d);
          // Texts the last socket took and never brought back, or written while there was none, in their order; the Room
          // answers them in that order too. One that waited a day is not sent: it would come out of the blue.
          dropTooOld();
          for (const u of unconfirmed) sendText(u);
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
        case 'sealed':
          opening = opening.then(() => received(m)).catch((e: unknown) => console.error('opening a text failed', e));
          return;
        case 'error':
          if (you()) {
            // After the welcome an error means a frame of ours was dropped. Chat-related ones are said in the chat;
            // signaling ones, and any the server cannot attribute, are a developer concern and would only confuse in the
            // chat: an oversized signal once showed as "Not sent" (ticket 30).
            posthog.capture('frame_dropped', { ref: m.ref ?? 'unknown', reason: m.reason });
            if (!m.ref || m.ref === 'signal' || m.ref === 'ice') console.warn('dropped', m.ref ?? 'unknown', m.reason);
            else if (m.ref === 'sealed' || m.ref === 'text') {
              // The Room answers texts in the order they came: a refusal is for the oldest one still waiting, once the texts
              // the Room brought back before it are opened. The chat said it was not sent, so it is not sent again.
              const at = Date.now();
              opening = opening.then(() => {
                // Another tab took over, or the room was left: the waiting texts are no longer this socket's to drop.
                if (stopped || welcomed !== socket) return;
                push({ kind: 'system', text: `Not sent: ${m.reason}.`, at });
                if (unconfirmed.shift()) unconfirmedChanged();
              });
            } else push({ kind: 'system', text: `Dropped: ${m.reason}.`, at: Date.now() });
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

    socket.onclose = (e) => { clearTimeout(handshake); lost(socket, e.code, life); };
  }

  /** A socket is gone, closed or given up: try again after a while, unless the close says that cannot help. */
  function lost(socket: WebSocket, code: number, life: Life) {
    const rooms = sockets.size;
    sockets.delete(socket);
    clearInterval(pingTimer);
    if (ws === socket) ws = null;
    if (welcomed === socket) welcomed = null;
    setYou(null);
    if (stopped) return;
    // What tells a network that cut one socket from a phone that lost its network, or a tab asleep (ticket 54).
    const now = Date.now();
    posthog.capture('server_socket_closed', {
      code,
      ever_connected: everConnected,
      age_ms: life.welcomedAt === null ? null : now - life.welcomedAt,
      since_frame_ms: life.frameAt === null ? null : now - life.frameAt,
      visible: document.visibilityState === 'visible',
      online: navigator.onLine,
      rooms,
      ...(GIVEN_UP[code] ? { reason: GIVEN_UP[code] } : {}),
    });
    if (code === CLOSE_SUPERSEDED) {
      stopped = true;
      // The room is another tab's now, and so are the texts still out: it took them from the browser's storage as it
      // opened. Kept here, they would be sent when this one takes the room back, maybe hours later.
      unconfirmed.length = 0;
      unconfirmedChanged(false);
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
    if (ws) sockets.delete(ws);
    ws?.close(1000, 'bye');
  });

  return {
    roomId: opts.roomId,
    status,
    you,
    people,
    /** The chat: what came back from the Room, then my own texts still on their way, as waiting. */
    lines: createMemo((): ChatLine[] => {
      const waiting = pending();
      if (!waiting.length) return lines();
      const { name, picture } = carried(latest);
      const me: Identity = you() ?? { publicKey: opts.identity.publicKey, fingerprint: opts.identity.fingerprint, name, ...(picture ? { picture } : {}) };
      return [...lines(), ...waiting.map((u): ChatLine => ({ kind: 'text', id: `pending:${u.id}`, from: me, text: u.text, at: u.at, pending: true }))];
    }),
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
    /**
     * Sends a text, or keeps it for the next socket while there is none. It shows as waiting until the Room brings it back;
     * a socket lost meanwhile sends it again on the next one.
     */
    sendText: (text: string) => {
      // The Room cannot read a sealed text to refuse it, and friends would drop it unseen (core/sealed.ts): said here instead.
      if (text.length > MAX_TEXT_LENGTH) { push({ kind: 'system', text: `Not sent: message longer than ${MAX_TEXT_LENGTH} characters.`, at: Date.now() }); return; }
      const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join(''); // not randomUUID: http on a LAN too
      unconfirmed.push({ id, text, at: Date.now() });
      unconfirmedChanged();
      sendText({ id, text });
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
    takeOver: () => {
      if (status().kind !== 'elsewhere') return;
      // What the other tab still had out, as it left it.
      unconfirmed.push(...loadUnsent(opts.roomId));
      unconfirmedChanged(false);
      stopped = false; attempt = 0; downSince = null; setStatus({ kind: 'connecting' }); open();
    },
    /** Fires for texts from other people (for the message cue). */
    onText: (l: (m: Text) => void) => { textListeners.add(l); return () => textListeners.delete(l); },
    /** Messages the room store does not handle itself (call, left, signal, ice) go to subscribers. */
    subscribe: (l: (m: ServerMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
}
