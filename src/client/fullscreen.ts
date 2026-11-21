// Fullscreen for a tile (a share's, the game's, client/App.tsx and client/Game.tsx), with Safari's prefixed API where it
// has no other, and never a throw: a browser may refuse it at any moment.
type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
export const fullscreenElement = (): Element | null => { const d = document as FullscreenDoc; return d.fullscreenElement ?? d.webkitFullscreenElement ?? null; };
/** Whether this browser makes an element fullscreen at all: iPhone Safari does not. */
export const canFullscreen = (): boolean => { const d = document as FullscreenDoc; return d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true; };
export const exitFullscreenSafely = (): void => {
  const d = document as FullscreenDoc;
  try { void Promise.resolve(d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.()).catch(() => {}); } catch { /* not in fullscreen anymore */ }
};
export const requestFullscreenSafely = (el: FullscreenEl, video?: HTMLVideoElement & { webkitEnterFullscreen?: () => void }): void => {
  try {
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) void Promise.resolve(el.webkitRequestFullscreen()).catch(() => {});
    else video?.webkitEnterFullscreen?.(); // iPhone Safari has no element fullscreen, only the native video player
  } catch { /* not allowed here */ }
};
