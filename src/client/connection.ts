import { createSignal } from 'solid-js';
import { buildAuthMessage } from '../core/identity';
import { CLOSE_AUTH_FAILED, CLOSE_NOT_CONFIGURED, type ClientMessage, type Identity, type ServerMessage } from '../core/protocol';
import type { LocalIdentity } from './identity';

export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'authenticating' }
  | { kind: 'connected'; you: Identity }
  | { kind: 'refused'; reason: string }
  | { kind: 'closed'; code: number; reason: string };

/**
 * One socket to the Room. Handles the challenge handshake, then hands every other
 * server message to `onMessage` (used from ticket 03 on). Reconnection policy arrives with ticket 03.
 */
export function connect(opts: { identity: LocalIdentity; secret: string; name: string; onMessage?: (m: ServerMessage) => void }) {
  const [status, setStatus] = createSignal<ConnectionStatus>({ kind: 'connecting' });
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    switch (m.t) {
      case 'challenge': {
        setStatus({ kind: 'authenticating' });
        send(await buildAuthMessage({ secret: opts.secret, nonce: m.nonce, publicKeyRaw: opts.identity.publicKeyRaw, privateKey: opts.identity.keys.privateKey, name: opts.name }));
        return;
      }
      case 'welcome':
        setStatus({ kind: 'connected', you: m.you });
        return;
      case 'error':
        if (status().kind === 'authenticating') {
          // One wrong answer means our stored secret is wrong; retrying cannot help, so close now.
          setStatus({ kind: 'refused', reason: m.reason });
          ws.close(1000, 'refused');
        }
        return;
      default:
        opts.onMessage?.(m);
    }
  };
  ws.onclose = (e) => {
    const reason = e.code === CLOSE_AUTH_FAILED ? 'the invite link is wrong or has been rotated'
      : e.code === CLOSE_NOT_CONFIGURED ? 'the server has no room secret configured' : e.reason;
    setStatus((s) => (s.kind === 'refused' ? s : { kind: 'closed', code: e.code, reason }));
  };

  return { status, send, close: () => ws.close(1000, 'bye') };
}
