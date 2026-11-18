import { firstVideoIn, MAX_VIDEO_SEARCH, normalSearch } from '../core/youtube';

/**
 * `/yt-search`: the first video YouTube finds for a search, for `/yt` in the composer (core/youtube.ts,
 * `videoSearchOf`). A browser cannot read YouTube's search page itself (no CORS), and YouTube's API wants a key and allows
 * about a hundred searches a day; so the Worker reads the page, as a browser with no cookies would, and answers
 * `{ id }`. The words are the POST's body: Cloudflare's logs of the Worker keep its addresses, and the words are a sealed
 * text's. Nothing found, or YouTube out of reach, is a 200 with `error`: an error status would be logged in the
 * browser's console. No Durable Object is asked, so this costs a Worker request and none of the day's Durable Object time.
 */
export const VIDEO_SEARCH_PATH = '/yt-search';

/** YouTube's filter for videos alone: no channels, playlists or shelves of Shorts among the results. */
const VIDEOS_ONLY = 'EgIQAQ==';
/** How long the Worker waits for YouTube's page. */
const SEARCH_WAIT_MS = 8_000;

/** A search's body is far shorter than this: a stranger's that is longer is not read past it. */
const MAX_BODY_BYTES = 4 * MAX_VIDEO_SEARCH;

/** A body as text, or null when it is longer than `max` bytes; read only that far. */
export async function upTo(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) { void reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

export const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function videoSearch(request: Request, env: Env): Promise<Response> {
  try {
    const body = await upTo(request.body, MAX_BODY_BYTES);
    const q = body === null ? null : normalSearch(body);
    if (!q) return json({ error: 'no search' });
    // A stranger asking over and over would have YouTube see this Worker do it: under the same limit per IP as sockets,
    // counted apart from them.
    const limiter = env.UPGRADE_LIMIT;
    if (limiter) {
      const { success } = await limiter.limit({ key: `yt-search ${request.headers.get('cf-connecting-ip') ?? 'unknown'}` });
      if (!success) return json({ error: 'too many searches' });
    }
    const url = new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query', q);
    url.searchParams.set('sp', VIDEOS_ONLY);
    const page = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        'accept-language': request.headers.get('accept-language') ?? 'en',
        // Consent answered (rejected), so a Worker in Europe gets the results, not YouTube's consent page.
        cookie: 'SOCS=CAI',
      },
      signal: AbortSignal.timeout(SEARCH_WAIT_MS),
    });
    if (!page.ok) {
      console.log('video search failed', JSON.stringify({ status: page.status }));
      return json({ error: 'unavailable' });
    }
    const id = firstVideoIn(await page.text());
    // No results page is YouTube refusing, or changed: told apart from a search that found nothing, in the log too.
    if (id === undefined) console.log('video search failed', JSON.stringify({ reason: 'no results page' }));
    else if (!id) console.log('video search found nothing', JSON.stringify({ length: q.length }));
    return json(id ? { id } : { error: id === undefined ? 'unavailable' : 'none' });
  } catch (e) {
    // Its name alone: a message could carry the address asked, and with it the search's words.
    console.log('video search failed', JSON.stringify({ reason: e instanceof Error ? e.name : 'unknown' }));
    return json({ error: 'unavailable' });
  }
}
