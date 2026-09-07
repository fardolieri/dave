// Chat input rules (spec §7): plain logic, no DOM, so they can be unit-tested.

/** The server-connection phases the chat input reacts to. Mirrors ServerStatus['kind'] in the client room. */
export type ChatConnKind = 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'refused';

/**
 * Whether the message input accepts typing, and what its placeholder says, for each phase.
 * The input stays editable while the socket comes up or comes back. A draft typed then is
 * buffered and sent once the welcome frame lands, so the normal cold start and a short blip
 * never lock chat. Only a long outage or a refused room disables the field.
 */
export function chatInputState(kind: ChatConnKind): { editable: boolean; placeholder: string } {
  switch (kind) {
    case 'connected':
      return { editable: true, placeholder: 'Message the room' };
    case 'connecting':
      return { editable: true, placeholder: 'Connecting…' };
    case 'reconnecting':
      return { editable: true, placeholder: 'Reconnecting… your message sends when you are back' };
    default:
      return { editable: false, placeholder: "Can't send while disconnected" };
  }
}
