import { describe, expect, it } from 'vitest';
import { chatInputState } from '../src/core/chat';

describe('chat input state', () => {
  it('keeps the input editable while the socket is up or coming back', () => {
    expect(chatInputState('connected').editable).toBe(true);
    expect(chatInputState('connecting').editable).toBe(true);
    expect(chatInputState('reconnecting').editable).toBe(true);
  });

  it('disables the input only on a long outage or a refused room', () => {
    expect(chatInputState('unavailable').editable).toBe(false);
    expect(chatInputState('refused').editable).toBe(false);
  });

  it('shows the scary copy only when the input is disabled', () => {
    expect(chatInputState('connecting').placeholder).not.toBe("Can't send while disconnected");
    expect(chatInputState('connected').placeholder).toBe('Message the room');
    expect(chatInputState('unavailable').placeholder).toBe("Can't send while disconnected");
    expect(chatInputState('refused').placeholder).toBe("Can't send while disconnected");
  });
});
