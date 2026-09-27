import { describe, expect, it } from 'vitest';
import { precacheUrls } from '../src/core/precache';

describe('precacheUrls', () => {
  it('caches every served file of a build as a URL, index.html as the root', () => {
    expect(precacheUrls(['index.html', 'assets/index-B_MR.js', 'assets/index-CBzW.css', 'icon-192.png', 'manifest.webmanifest']))
      .toEqual(['/', '/assets/index-B_MR.js', '/assets/index-CBzW.css', '/icon-192.png', '/manifest.webmanifest']);
  });
  it('leaves out source maps, the service worker itself, and dotfiles', () => {
    expect(precacheUrls(['index.html', 'assets/index-B_MR.js.map', 'sw.js', 'sw.js.map', '.assetsignore', '.vite/manifest.json'])).toEqual(['/']);
  });
  it('is sorted and without repeats, so one build always gives one list', () => {
    expect(precacheUrls(['b.png', 'a.png', 'b.png'])).toEqual(['/a.png', '/b.png']);
  });
});
