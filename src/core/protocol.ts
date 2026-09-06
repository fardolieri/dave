// Wire protocol shared by client and server. Runtime-neutral: plain data only.
// Ticket 01 carries only what the skeleton needs; later tickets extend these unions.

export type ClientMessage = { t: 'ping' } | { t: 'echo'; text: string };

export type ServerMessage = { t: 'pong' } | { t: 'echo'; text: string } | { t: 'error'; reason: string };

export const MAX_MESSAGE_BYTES = 4096;

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('t' in value)) return null;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'ping':
      return { t: 'ping' };
    case 'echo':
      return typeof m.text === 'string' ? { t: 'echo', text: m.text } : null;
    default:
      return null;
  }
}
