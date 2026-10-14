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
export async function failAudioContext(ctx: AudioContext): Promise<void> {
  await ctx.suspend();
  ctx.dispatchEvent(new Event('error'));
}
