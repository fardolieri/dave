// `/gif rick roll`: the first GIF Tenor finds, sent after the text as a picture (attachments ticket 08), as `/yt` sends a
// video's card (core/youtube.ts). Tenor's search page is read by our Worker (worker/gifsearch.ts), the GIF by the sender's
// browser: Tenor's media let any page read them (CORS).
import { normalSearch } from './youtube';

/**
 * What a text asks Tenor for with `/gif`, or null when it asks for nothing: `/gif rick roll` sends as it is, and the sender's
 * app sends the first GIF Tenor finds for "rick roll" after it. Its words on one line.
 */
export function gifSearchOf(text: string): string | null {
  const m = /^\/gif\s+(\S[\s\S]*)$/i.exec(text.trim());
  return m ? normalSearch(m[1]!) : null;
}

/**
 * Tenor's search page for a search: its words joined by dashes, in lower case, as Tenor redirects any other to. Tenor reads
 * a slash or a question mark there as its own, so they go, and decodes no `&`, `+` or `:` there, so they stay as they are;
 * null when no words are left, for which Tenor has no page.
 */
export function gifSearchUrl(search: string): string | null {
  const words = search.toLowerCase().replace(/[/?#\\]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length ? `https://tenor.com/search/${words.map(encodeURI).join('-')}-gifs` : null;
}

/** The most a GIF sent for `/gif` weighs: Tenor's animated WebP of one is a few hundred kB, its GIF up to tens of MB. */
export const MAX_GIF_BYTES = 4 * 1024 * 1024;
/** A file of Tenor's, on its hosts, as its pages link them: media.tenor.com, media1.tenor.com and the like. */
const TENOR_MEDIA = /^https:\/\/media\d*\.tenor\.com\/[A-Za-z0-9_\-./%]+\.(webp|gif)$/;
export const isTenorMedia = (v: unknown): v is string => typeof v === 'string' && v.length <= 300 && TENOR_MEDIA.test(v);
/**
 * Which of a result's files is sent, the first there is within MAX_GIF_BYTES: an animated WebP is a tenth of its GIF, so
 * the small WebP goes before the GIF.
 */
const FORMATS = ['webp', 'tinywebp', 'gif', 'mediumgif', 'tinygif'];

/**
 * The first GIF of a page of Tenor's search results, as the address of the file to send; null when Tenor found none;
 * undefined for anything else, a page laid out anew or no page of results at all, so that the Worker says Tenor did not
 * answer, and logs it. The results are in the page as Tenor's API gives them, in its `store-cache`; stickers and still
 * pictures among them are passed over.
 */
export function firstGifIn(page: string): string | null | undefined {
  const m = /<script id="store-cache"[^>]*>([\s\S]*?)<\/script>/.exec(page);
  if (!m) return undefined;
  let results: unknown;
  try {
    const searches = (JSON.parse(m[1]!) as { universal?: { search?: Record<string, { results?: unknown }> } }).universal?.search;
    results = searches && Object.values(searches)[0]?.results;
  } catch {
    return undefined;
  }
  if (!Array.isArray(results)) return undefined;
  for (const r of results as Array<{ flags?: unknown; media_formats?: Record<string, { url?: unknown; size?: unknown } | undefined> }>) {
    if (Array.isArray(r?.flags) && (r.flags.includes('sticker') || r.flags.includes('static'))) continue;
    for (const f of FORMATS) {
      const file = r?.media_formats?.[f];
      if (file && isTenorMedia(file.url) && typeof file.size === 'number' && file.size > 0 && file.size <= MAX_GIF_BYTES) return file.url;
    }
  }
  return null;
}
