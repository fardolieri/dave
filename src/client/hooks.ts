/**
 * Whether this build exposes the inspection hooks (`window.__dave`, `window.__daveCues`) the Playwright suite reads.
 * On in the dev server, the local e2e build and nightly (`VITE_E2E=1`, see playwright.config.ts and deploy.yml); absent
 * from the bundles deployed to friends.
 */
export const exposeHooks: boolean = import.meta.env.DEV || import.meta.env['VITE_E2E'] === '1';
