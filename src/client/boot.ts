/**
 * The start of the app. index.html paints the first frame before any script runs: the app's dark, and over it the
 * logo (#boot) where the phone's own splash had it, so the hand-over from the splash does not show. The app fades the
 * logo out once it has a screen to show: the room, or a screen that asks something of you.
 */

/** The logo's fade-out in index.html (`#boot { transition }`); friends arriving before it is over wait for it. */
const FADE_MS = 300;
/** The beat between the logo gone and the first friend sliding in. */
const BEAT_MS = 150;

let fadedAt: number | null = null;

/** Fades the logo out and removes it. Safe to call many times, from any screen. */
export function reveal(): void {
  if (fadedAt !== null) return;
  fadedAt = performance.now() + FADE_MS;
  const el = document.getElementById('boot');
  if (!el) return;
  el.classList.add('gone');
  void getComputedStyle(el).opacity; // starts the transition now, so getAnimations sees it
  // Removed once the fade is over; with no fade (reduced motion) at once.
  void Promise.all(el.getAnimations().map((a) => a.finished)).finally(() => el.remove());
}

/** How long something arriving now waits so it comes after the logo has gone: 0 once that moment is past. */
export const waitForReveal = (): number => (fadedAt === null ? FADE_MS + BEAT_MS : Math.max(0, fadedAt + BEAT_MS - performance.now()));
