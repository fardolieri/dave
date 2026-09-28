/** The service worker's own file (ticket 33): at the root, unhashed, so its scope is the whole app and its URL never changes. */
export const SW_FILE = 'sw.js';

/**
 * What the service worker caches at install, from the files of a build: all of them but source maps (only devtools asks
 * for those), the service worker itself, and dotfiles (build metadata, never served). index.html is cached as `/`, the
 * URL every page load is answered with. Sorted, so the same build gives the same list.
 */
export function precacheUrls(files: string[]): string[] {
  const kept = files.filter((f) => !f.endsWith('.map') && f !== SW_FILE && !f.split('/').some((part) => part.startsWith('.')));
  return [...new Set(kept.map((f) => (f === 'index.html' ? '/' : `/${f}`)))].sort();
}

/**
 * A build's version, which names its cache (`dave-<version>`): the build time in seconds, base 36, then a hash of the
 * cached files. The time comes first so a service worker can tell an older version's cache from a newer one's by name
 * alone (client/sw.ts reads it back with the same rule and deletes only older ones). A name from before the stamp has
 * no second dash and counts as older than any.
 */
export const cacheVersion = (builtAt: string, hash: string): string => `${Math.floor(Date.parse(builtAt) / 1000).toString(36)}-${hash}`;

/** The version a build one second later would carry, tagged instead of hashed: how the e2e preview server stages a deploy (vite.config.ts). */
export function laterVersion(version: string, tag: string): string {
  const stamp = version.split('-')[0]!;
  return `${(parseInt(stamp, 36) + 1).toString(36)}-${tag}`;
}
