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
