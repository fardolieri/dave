import { createSignal, onCleanup } from 'solid-js';
import posthog from './posthog';
import { buildAuthMessage } from '../core/identity';
import {
  CLOSE_AUTH_FAILED, CLOSE_SUPERSEDED, PING_FRAME, PING_INTERVAL_MS,
  type ClientMessage, type Identity, type Person, type ServerMessage,
} from '../core/protocol';
import type { LocalIdentity } from './identity';
import { appendHistory, clearHistory, isNote, lineKey, loadHistory, textKey, type StoredLine } from './history';
import { formatDuration } from '../core/format';

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
const BACKOFF_MAX_MS = 30_000;
/**
 * A reconnect gets a line in the chat only from this gap on. Most socket drops heal in one or two seconds
 * (PostHog, Sep 2026: median 1.5 s, four in five under 5 s) and one friend on a flaky link collected ten
 * such lines in a morning (report of Sep 16). A gap that short rarely loses a text; a long one still says so.
 */
const NOTE_GAP_MS = 10_000;

/**
 * The client's view of one Room: one WebSocket with the challenge handshake,
 * reconnection with exponential backoff (spec §8.1), presence snapshots, and
 * ephemeral text. The call (WebRTC) is layered on top by createCall.
 */
export function createRoom(opts: { identity: LocalIdentity; roomId: string; authKey: string; name: string; picture: string | null }) {
  // The self-declared name and picture: sent at every (re)connect, changeable live through `rename` and `setPicture`.
  let name = opts.name;
  let picture = opts.picture;
  const [status, setStatus] = createSignal<ServerStatus>({ kind: 'connecting' });
  const [you, setYou] = createSignal<Person | null>(null);
  const [people, setPeople] = createSignal<Person[]>([]);
  const [lines, setLines] = createSignal<ChatLine[]>([]);
  /** Texts from others that arrived live while this room was not the one on screen. */
  const [unread, setUnread] = createSignal(0);
  const listeners = new Set<(m: ServerMessage) => void>();
  const textListeners = new Set<(m: Extract<ServerMessage, { t: 'text' }>) => void>();
  let nextId = 1;
  // Recent history from this browser, loaded once; live lines append after it.
  const fromStored = (m: StoredLine): ChatLine => (isNote(m) ? { kind: 'system', id: lineKey(m), text: m.note, at: m.at } : { kind: 'text', id: textKey(m), ...m });
  void loadHistory(opts.roomId).then((stored) => setLines((l) => [...stored.map(fromStored), ...l]));
  const push = (line: { kind: 'text'; id: string; from: Identity; text: string; at: number } | { kind: 'system'; text: string; at: number }) =>
    setLines((l) => [...l, 'id' in line ? (line as ChatLine) : ({ ...line, id: `sys-${nextId++}` } as ChatLine)]);
  /**
   * A dated line about this browser's own connection, kept in the local history so a gap where
   * messages may be missing stays visible later. Every reconnect gets its own line on purpose.
   */
  const note = (text: string) => {
    const at = Date.now();
    setLines((l) => [...l, { kind: 'system', id: lineKey({ note: text, at }), text, at }]);
    void appendHistory(opts.roomId, { note: text, at });
  };
  
  let ws: WebSocket | null = null;
  let attempt = 0;
  let downSince: number | null = null;
  let everConnected = false;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;

  /** Write a frame if the socket is open; returns whether it went out, so a caller can re-assert what was dropped. */
  const send = (m: ClientMessage): boolean => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };

  function open() {
    if (stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws/${opts.roomId}`);
    ws = socket;

    socket.onopen = () => {
      pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(PING_FRAME), PING_INTERVAL_MS);
    };

    socket.onmessage = async (e) => {
      const m = JSON.parse(e.data as string) as ServerMessage;
      switch (m.t) {
        case 'challenge': {
          const auth = await buildAuthMessage({
            authKey: opts.authKey, nonce: m.nonce, publicKeyRaw: opts.identity.publicKeyRaw, privateKey: opts.identity.keys.privateKey, name, ...(picture ? { picture } : {}),
          });
          // Nobody has entered this room yet: our answer also hands the server the verifier (ADR 0004).
          socket.send(JSON.stringify(m.fresh ? { ...auth, authKey: opts.authKey } : auth));
          return;
        }
        case 'welcome':
          attempt = 0;
          setYou(m.you);
          setStatus({ kind: 'connected' });
          if (everConnected) {
            // "about": a dead socket is only noticed when a ping goes unanswered, so the real gap can be longer.
            const downMs = downSince ? Date.now() - downSince : 0;
            if (downMs >= NOTE_GAP_MS) note(`Reconnected after about ${formatDuration(downMs)} offline. Messages sent meanwhile are missing here.`);
            posthog.capture('server_reconnected', { down_ms: downMs });
          }
          everConnected = true;
          downSince = null;
          clearTimeout(unavailableTimer);
          return;
        case 'presence':
          setPeople(m.people);
          return;
        case 'text': {
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
            // signaling ones are a developer concern and would only confuse in the chat.
            posthog.capture('frame_dropped', { ref: m.ref ?? 'unknown', reason: m.reason });
            if (m.ref === 'signal' || m.ref === 'ice') console.warn('dropped', m.ref, m.reason);
            else push({ kind: 'system', text: `${m.ref === 'text' || !m.ref ? 'Not sent' : 'Dropped'}: ${m.reason}.`, at: Date.now() });
          } else if (status().kind !== 'refused') {
            // A wrong answer during the handshake: our stored secret is wrong. Retrying cannot help.
            setStatus({ kind: 'refused', reason: m.reason });
            stopped = true;
            socket.close(1000, 'refused');
          }
          return;
        case 'pong':
          return;
        default:
          for (const l of listeners) l(m);
      }
    };

    socket.onclose = (e) => {
      clearInterval(pingTimer);
      if (ws === socket) ws = null;
      setYou(null);
      if (stopped) return;
      posthog.capture('server_socket_closed', { code: e.code, ever_connected: everConnected });
      if (e.code === CLOSE_SUPERSEDED) {
        stopped = true;
        setStatus({ kind: 'elsewhere' });
        return;
      }
      if (e.code === CLOSE_AUTH_FAILED) {
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
    };
  }

  open();
  onCleanup(() => {
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
    send,
    sendText: (text: string) => { send({ t: 'text', text }); posthog.capture('message_sent'); },
    /** Empties the local history; the server never had it. */
    clearHistory: async () => { await clearHistory(opts.roomId); setLines([]); },
    /** Dev aid for scripts/drive.mjs: drops the socket so the reconnect path runs. */
    dropSocket: () => ws?.close(),
    /** Change the name everyone sees; presence brings it back. A later reconnect authenticates with it too. */
    rename: (next: string) => { name = next; send({ t: 'name', name: next }); },
    /** Choose the emoji everyone sees as your avatar, or null for the initial; presence brings it back. */
    setPicture: (next: string | null) => { picture = next; send({ t: 'picture', picture: next }); },
    /** After stepping back for another tab: reconnect here, which supersedes that tab in turn. */
    takeOver: () => { if (status().kind !== 'elsewhere') return; stopped = false; attempt = 0; downSince = null; setStatus({ kind: 'connecting' }); open(); },
    /** Fires for texts from other people (for the message cue). */
    onText: (l: (m: Extract<ServerMessage, { t: 'text' }>) => void) => { textListeners.add(l); return () => textListeners.delete(l); },
    /** Messages the room store does not handle itself (call, left, signal, ice) go to subscribers. */
    subscribe: (l: (m: ServerMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
}
