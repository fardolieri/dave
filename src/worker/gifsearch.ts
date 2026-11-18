import { firstGifIn, gifSearchUrl } from '../core/gif';
import { MAX_VIDEO_SEARCH, normalSearch } from '../core/youtube';
import { json, upTo } from './ytsearch';

/**
 * `/gif-search`: the first GIF Tenor finds for a search, for `/gif` in the composer (core/gif.ts, `gifSearchOf`), as
 * `/yt-search` finds a video (worker/ytsearch.ts), and for the same reasons: a browser cannot read Tenor's search page
 * itself (no CORS), and Tenor's API wants a key. So the Worker reads the page, as a browser with no cookies would, and
 * answers `{ url }`, the address of the GIF's file, which the sender's browser fetches itself. The words are the POST's
 * body; nothing found, or Tenor out of reach, is a 200 with `error`. No Durable Object is asked.
 */
export const GIF_SEARCH_PATH = '/gif-search';

/** How long the Worker waits for Tenor's page. */
const SEARCH_WAIT_MS = 8_000;

export async function gifSearch(request: Request, env: Env): Promise<Response> {
  try {
    const body = await upTo(request.body, 4 * MAX_VIDEO_SEARCH);
    const q = body === null ? null : normalSearch(body);
    if (!q) return json({ error: 'no search' });
    // Under the same limit per IP as sockets, counted apart from them and from `/yt-search`.
    const limiter = env.UPGRADE_LIMIT;
    if (limiter) {
      const { success } = await limiter.limit({ key: `gif-search ${request.headers.get('cf-connecting-ip') ?? 'unknown'}` });
      if (!success) return json({ error: 'too many searches' });
    }
    const url = gifSearchUrl(q);
    if (!url) return json({ error: 'none' }); // nothing but marks Tenor reads as its own: no page to ask
    const page = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        'accept-language': request.headers.get('accept-language') ?? 'en',
      },
      signal: AbortSignal.timeout(SEARCH_WAIT_MS),
    });
    // Tenor answers a search with no results (`.`, say) with a 404, its page of no results still in it.
    const gif = page.ok || page.status === 404 ? firstGifIn(await page.text()) : undefined;
    if (!page.ok && gif !== null) {
      console.log('gif search failed', JSON.stringify({ status: page.status }));
      return json({ error: 'unavailable' });
    }
    if (gif === undefined) console.log('gif search failed', JSON.stringify({ reason: 'no results page' }));
    else if (!gif) console.log('gif search found nothing', JSON.stringify({ length: q.length }));
    return json(gif ? { url: gif } : { error: gif === undefined ? 'unavailable' : 'none' });
  } catch (e) {
    // Its name alone: a message could carry the address asked, and with it the search's words.
    console.log('gif search failed', JSON.stringify({ reason: e instanceof Error ? e.name : 'unknown' }));
    return json({ error: 'unavailable' });
  }
}
