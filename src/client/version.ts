/** Which commit this copy of the app was built from, baked in by vite.config.ts at build time. */
export type BuildInfo = {
  commit: string;
  subject: string;
  body: string;
  /** ISO timestamps. */
  committedAt: string;
  builtAt: string;
  /** 'live' (prod), 'nightly', or 'local' for a build outside the deploy workflow. */
  target: string;
  /** Built from a working tree with uncommitted changes. */
  dirty: boolean;
};

declare const __BUILD__: BuildInfo;
export const build: BuildInfo = __BUILD__;

export const REPO_URL = 'https://github.com/fardolieri/dave';
export const commitUrl = (commit: string): string => `${REPO_URL}/commit/${commit}`;
export const shortCommit = (commit: string): string => commit.slice(0, 7) || 'unknown';
