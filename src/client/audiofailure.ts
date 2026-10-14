import posthog from './posthog';

/** How long after each failure in a row the context is started again; the failure after the last gives up. */
const RESTART_AFTER_MS = [0, 1_000, 5_000, 15_000];
/** A context that ran this long since it last started has recovered: its next failure counts as the first again. */
const RECOVERED_MS = 10_000;
/** A restart that has not made the context run by then, and brought no new failure, gives up too. */
const RESTART_WAIT_MS = 5_000;

/** Starts the context again; where the app used to call resume() on it, it calls this. */
export type ContextStarter = { startAgain(): void };

/**
 * Starts an AudioContext again after the audio device or the browser's audio renderer failed under it (soak issues #39,
 * #49, #50, #51). Chromium then stops the context, fires `error` and leaves it "suspended"
 * (AudioContext::HandleRenderError), and logs "The AudioContext encountered an error from the audio device or the
 * WebAudio renderer." Nothing else in the app starts a context it believed running, so the call's voices or the cues
 * stayed silent until a reload.
 *
 * A start can fail the same way (another `error`, its resume() never settles), and after that a plain resume() no longer
 * starts the context at all: suspend() first, then resume(), does (probe runs 38596709506 and 38597053278 on a runner).
 * So every start of a context that failed is both, here and in `startAgain`. After a few failures in a row `gaveUp`
 * runs, for a click to start it, and a warning says so. Firefox and Safari fire no `error` on an AudioContext today:
 * nothing changes there.
 */
export function restartOnFailure(ctx: AudioContext, name: 'call' | 'cues' | 'voice', gaveUp: () => void): ContextStarter {
  let failures = 0;
  let lastAt = 0;
  /** Failed since it last ran: a plain resume() may not start it. */
  let failed = false;
  let given = false;
  let ranAt = 0;
  // After a click the resume() comes a moment after the gesture: fine where this runs, Chromium only asks that the page had one.
  const restart = () => { void ctx.suspend().then(() => ctx.resume()).catch(() => {}); };
  const giveUp = () => {
    if (given) return;
    given = true;
    console.warn(`[audio] the ${name} AudioContext stopped after ${failures} failures of the audio device; a click starts it again`);
    posthog.capture('audio_context_gave_up', { context: name, failures });
    gaveUp();
  };
  ctx.addEventListener('statechange', () => {
    if (ctx.state !== 'running') return;
    failed = false;
    given = false;
    ranAt = Date.now();
  });
  ctx.addEventListener('error', () => {
    const at = Date.now();
    if (ranAt && at - ranAt > RECOVERED_MS) failures = 0;
    ranAt = 0;
    lastAt = at;
    failed = true;
    const delay = RESTART_AFTER_MS[failures++];
    posthog.capture('audio_context_error', { context: name, failures });
    if (delay === undefined) { giveUp(); return; }
    setTimeout(() => {
      // Started meanwhile (a click, the microphone opening), closed, or failed again: nothing to do here.
      if (ctx.state !== 'suspended' || lastAt !== at) return;
      restart();
      setTimeout(() => { if (ctx.state === 'suspended' && lastAt === at) giveUp(); }, RESTART_WAIT_MS);
    }, delay);
  });
  return {
    startAgain(): void {
      if (ctx.state === 'closed') return;
      // One that never failed is resumed at once, inside the gesture where there is one, as before.
      if (failed) restart(); else void ctx.resume().catch(() => {});
    },
  };
}
