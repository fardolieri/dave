import { describe, expect, it } from 'vitest';
import { MAX_GIF_BYTES, firstGifIn, gifSearchOf, gifSearchUrl, isTenorMedia } from '../src/core/gif';
import { MAX_VIDEO_SEARCH } from '../src/core/youtube';
import { parseFileMeta } from '../src/core/attachment';

/** A result as Tenor's search page has it, in its `store-cache` (cut down: the page's have twenty fields more). */
const result = (name: string, flags: string[] = [], sizes: Record<string, number> = { webp: 346_970, gif: 5_784_892 }) => ({
  id: '14396870704937998862',
  flags,
  h1_title: `${name} GIF`,
  media_formats: Object.fromEntries(Object.entries(sizes).map(([f, size]) => [f, {
    url: `https://${f === 'gif' ? 'media1.tenor.com/m' : 'media.tenor.com'}/x8v1oNUOmg4AAAA${f.length}/${name}.${f.includes('webp') ? 'webp' : 'gif'}`,
    size, dims: [498, 498],
  }])),
});
/** A page of Tenor's search results, as it served one on 2026-11-18. */
const page = (results: unknown[]) =>
  `<html><head><title>Rick Roll GIFs | Tenor</title></head><body><div id="root"></div><script id="store-cache" type="text/x-cache" nonce="ZWQw">${
    JSON.stringify({ appConfig: {}, gifs: { byId: {} }, universal: { search: { 'rick roll-low-all': { results, next: '50', loaded: true } } } })
  }</script></body></html>`;

describe('/gif', () => {
  it('asks for the words after it, on one line, cut to a search\'s length', () => {
    expect(gifSearchOf('/gif rick roll')).toBe('rick roll');
    expect(gifSearchOf('  /GIF   rick\n  roll  ')).toBe('rick roll');
    expect(gifSearchOf('/gif 🎲'.padEnd(200, 'x'))).toHaveLength(MAX_VIDEO_SEARCH);
    for (const text of ['/gif', '/gif   ', '/gifrick roll', 'say /gif rick roll', '//gif rick roll', '/gifs rick roll', '/yt rick roll']) expect(gifSearchOf(text), text).toBeNull();
  });

  it('asks Tenor\'s search page, its words joined by dashes, with nothing Tenor would read as its own', () => {
    expect(gifSearchUrl('rick roll')).toBe('https://tenor.com/search/rick-roll-gifs');
    expect(gifSearchUrl('Überraschung 🎲 100%')).toBe('https://tenor.com/search/%C3%BCberraschung-%F0%9F%8E%B2-100%25-gifs');
    expect(gifSearchUrl('rock & roll c++ 10:30 "hi"')).toBe('https://tenor.com/search/rock-&-roll-c++-10:30-%22hi%22-gifs');
    expect(gifSearchUrl('what? a/b #1')).toBe('https://tenor.com/search/what-a-b-1-gifs');
    expect(gifSearchUrl('???')).toBeNull();
  });

  it('takes the first animated result\'s WebP, else its small WebP, else its GIF, within the most a GIF may weigh', () => {
    expect(firstGifIn(page([result('rickroll-roll'), result('second')]))).toBe('https://media.tenor.com/x8v1oNUOmg4AAAA4/rickroll-roll.webp');
    expect(firstGifIn(page([result('heavy', [], { webp: MAX_GIF_BYTES + 1, gif: 900_000 })]))).toBe('https://media1.tenor.com/m/x8v1oNUOmg4AAAA3/heavy.gif');
    expect(firstGifIn(page([result('long', [], { webp: MAX_GIF_BYTES + 1, gif: 3_900_000, tinywebp: 60_000 })]))).toBe('https://media.tenor.com/x8v1oNUOmg4AAAA8/long.webp');
    expect(firstGifIn(page([result('huge', [], { webp: MAX_GIF_BYTES + 1, gif: 20_000_000 }), result('next')])), 'too heavy in every form').toBe('https://media.tenor.com/x8v1oNUOmg4AAAA4/next.webp');
    expect(firstGifIn(page([result('meme', ['static']), result('duck', ['sticker']), result('heh-huh', ['audio'])])), 'a still picture and a sticker passed over').toBe('https://media.tenor.com/x8v1oNUOmg4AAAA4/heh-huh.webp');
  });

  it('says Tenor found none for no results, and did not answer for anything else', () => {
    expect(firstGifIn(page([]))).toBeNull();
    expect(firstGifIn(page([result('meme', ['static'])]))).toBeNull();
    const elsewhere = { ...result('evil'), media_formats: { webp: { url: 'https://evil.example/x.webp', size: 1000 } } };
    expect(firstGifIn(page([elsewhere])), 'none on Tenor\'s hosts').toBeNull();
    for (const other of ['<html>Our systems have detected unusual traffic</html>', '<script id="store-cache">{"universal":', '<script id="store-cache">{"universal":{}}</script>'])
      expect(firstGifIn(other), other).toBeUndefined();
  });

  it('fetches only Tenor\'s own media', () => {
    expect(isTenorMedia('https://media.tenor.com/x8v1oNUOmg4AAAAx/rickroll-roll.webp')).toBe(true);
    expect(isTenorMedia('https://media1.tenor.com/m/x8v1oNUOmg4AAAAC/rickroll-roll.gif')).toBe(true);
    for (const url of ['http://media.tenor.com/a/b.gif', 'https://media.tenor.com.evil.example/a/b.gif', 'https://tenor.com/view/x.gif', 'https://media.tenor.com/a/b.mp4', 'https://media.tenor.com/a/b.gif?x', 'https://evil.example/media.tenor.com/b.gif'])
      expect(isTenorMedia(url), url).toBe(false);
  });

  it('keeps a GIF\'s mark in its announcement, which an app from before drops', () => {
    const meta = { name: 'rickroll-roll.webp', type: 'image/webp', size: 346_970, hash: 'A'.repeat(43) };
    expect(parseFileMeta({ ...meta, gif: true })).toEqual({ ...meta, gif: true });
    expect(parseFileMeta({ ...meta, gif: 'yes' })).toEqual(meta);
  });
});
