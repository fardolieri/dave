// Room logic, runtime-neutral. The Durable Object adapter feeds it messages and
// sends back whatever it returns. No Cloudflare, Node, or DOM imports here; the
// test in scripts/check-core-isolation.mjs enforces that.
import { parseClientMessage, type ServerMessage } from './protocol';

export function handleClientMessage(raw: unknown): ServerMessage {
  const msg = parseClientMessage(raw);
  if (!msg) return { t: 'error', reason: 'unrecognised message' };
  switch (msg.t) {
    case 'ping':
      return { t: 'pong' };
    case 'echo':
      return { t: 'echo', text: msg.text };
  }
}
