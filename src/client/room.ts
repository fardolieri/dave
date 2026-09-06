import { createSignal, onCleanup } from 'solid-js';
import { buildAuthMessage } from '../core/identity';
import {
  CLOSE_AUTH_FAILED, CLOSE_NOT_CONFIGURED, PING_FRAME, PING_INTERVAL_MS,
  type ClientMessage, type Identity, type Person, type ServerMessage,
} from '../core/protocol';
import type { LocalIdentity } from './identity';

export type ServerStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'unavailable'; since: number }
  | { kind: 'refused'; reason: string };

export type ChatLine =
  | { kind: 'text'; id: number; from: Identity; text: string; at: number }
  | { kind: 'system'; id: number; text: string; at: number };

const UNAVAILABLE_AFTER_MS = 30_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * The client's view of the Room: one WebSocket with the challenge handshake,
 * reconnection with exponential backoff (spec §8.1), presence snapshots, and
 * ephemeral text. WebRTC state is added by later tickets.
 */
export function createRoom(opts: { identity: LocalIdentity; secret: string; name: string }) {
  const [status, setStatus] = createSignal<ServerStatus>({ kind: 'connecting' });
  const [you, setYou] = createSignal<Person | null>(null);
  const [people, setPeople] = createSignal<Person[]>([]);
  const [lines, setLines] = createSignal<ChatLine[]>([]);
  const listeners = new Set<(m: ServerMessage) => void>();
  let nextId = 1;
  type NewLine = { kind: 'text'; from: Identity; text: string; at: number } | { kind: 'system'; text: string; at: number };
  const push = (line: NewLine) => setLines((l) => [...l, { ...line, id: nextId++ }]);

  let ws: WebSocket | null = null;
  let attempt = 0;
  let downSince: number | null = null;
  let everConnected = false;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (m: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  function open() {
    if (stopped) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    ws = socket;

    socket.onopen = () => {
      pingTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(PING_FRAME), PING_INTERVAL_MS);
    };

    socket.onmessage = async (e) => {
      const m = JSON.parse(e.data as string) as ServerMessage;
      switch (m.t) {
        case 'challenge':
          socket.send(JSON.stringify(await buildAuthMessage({
            secret: opts.secret, nonce: m.nonce, publicKeyRaw: opts.identity.publicKeyRaw, privateKey: opts.identity.keys.privateKey, name: opts.name,
          })));
          return;
        case 'welcome':
          attempt = 0;
          setYou(m.you);
          setStatus({ kind: 'connected' });
          if (everConnected) push({ kind: 'system', text: 'Reconnected. You may have missed messages.', at: Date.now() });
          everConnected = true;
          downSince = null;
          clearTimeout(unavailableTimer);
          return;
        case 'presence':
          setPeople(m.people);
          return;
        case 'text':
          push({ kind: 'text', from: m.from, text: m.text, at: m.at });
          return;
        case 'error':
          if (you()) {
            // After the welcome an error means a frame of ours was dropped (rate limit, too long). Say so.
            push({ kind: 'system', text: `Not sent: ${m.reason}.`, at: Date.now() });
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
      if (e.code === CLOSE_AUTH_FAILED || e.code === CLOSE_NOT_CONFIGURED) {
        stopped = true;
        setStatus({ kind: 'refused', reason: e.code === CLOSE_AUTH_FAILED ? 'the invite link is wrong or has been rotated' : 'the server has no room secret configured' });
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
    status,
    you,
    people,
    lines,
    send,
    sendText: (text: string) => send({ t: 'text', text }),
    /** Messages the room store does not handle itself (call, left, signal, ice) go to subscribers. */
    subscribe: (l: (m: ServerMessage) => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
}
