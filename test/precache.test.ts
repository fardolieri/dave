import { describe, expect, it } from 'vitest';
import { cacheVersion, laterVersion, precacheUrls } from '../src/core/precache';

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

describe('cacheVersion', () => {
  it('puts the build time first, in seconds, base 36, then the hash', () => {
    expect(cacheVersion('2026-09-28T10:00:00.000Z', 'abcdef0123456789')).toBe(`${Math.floor(Date.parse('2026-09-28T10:00:00Z') / 1000).toString(36)}-abcdef0123456789`);
  });
  it('sorts by build time alone: a later build of the same files is newer', () => {
    const stamp = (v: string) => parseInt(v.split('-')[0]!, 36);
    expect(stamp(cacheVersion('2026-09-28T10:00:01Z', 'aaaa'))).toBeGreaterThan(stamp(cacheVersion('2026-09-28T10:00:00Z', 'zzzz')));
  });
});

describe('laterVersion', () => {
  it('is one second newer and carries the tag in place of the hash', () => {
    expect(laterVersion(cacheVersion('2026-09-28T10:00:00Z', 'abcd'), 'next')).toBe(cacheVersion('2026-09-28T10:00:01Z', 'next'));
  });
});
