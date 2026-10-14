/**
 * Whether this build exposes the inspection hooks (`window.__dave`, `window.__daveCues`) the Playwright suite reads.
 * On in the dev server, the local e2e build and nightly (`VITE_E2E=1`, see playwright.config.ts and deploy.yml); absent
 * from the bundles deployed to friends.
 */
export const exposeHooks: boolean = import.meta.env.DEV || import.meta.env['VITE_E2E'] === '1';

/**
 * Fails an AudioContext the way Chromium does when the audio device or its renderer errs under it
 * (AudioContext::HandleRenderError): rendering stops, an `error` event fires, the state reads "suspended". Chromium's
 * console line about it is left out. A suite has no device to pull out, so this is a copy of that path, not the real thing.
 */
export async function failAudioContext(ctx: AudioContext, stuck = false): Promise<void> {
  await ctx.suspend();
  if (stuck) {
    // As after a start that met another failure: resume() alone never settles and starts nothing; a suspend() first
    // lets the next resume() start it (probe run 38597053278).
    const own = ctx as unknown as { resume?: unknown; suspend?: unknown };
    const suspend = ctx.suspend.bind(ctx);
    own.resume = () => new Promise<void>(() => {});
    own.suspend = () => { delete own.resume; delete own.suspend; return suspend(); };
  }
  ctx.dispatchEvent(new Event('error'));
}
