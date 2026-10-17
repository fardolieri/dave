import { createSignal, type Accessor } from 'solid-js';

let focused: Accessor<boolean> | undefined;

/**
 * Whether this window has the friend's eye: its tab shown and the window focused. A window on a second screen, or behind
 * another one, is visible but not focused. Mirrored into one signal for the page on first use; the listeners stay for its
 * lifetime.
 */
export function windowFocused(): boolean {
  if (!focused) {
    const now = () => !document.hidden && document.hasFocus();
    const [get, set] = createSignal(now());
    const sync = () => set(now());
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    focused = get;
  }
  return focused();
}
