// `/gif rick roll` (core/gif.ts): the sender's browser asks our Worker which GIF Tenor finds first, then fetches that GIF
// from Tenor itself, which lets any page read its media (CORS), and sends it as a picture.
import { isTenorMedia, MAX_GIF_BYTES } from '../core/gif';

/** How long the sender's app waits for the Worker's search (worker/gifsearch.ts), which waits for Tenor up to 8 s. */
const SEARCH_WAIT_MS = 10_000;
/** How long the sender's browser waits for the GIF itself. */
const GIF_WAIT_MS = 10_000;

/**
 * The address of the first GIF Tenor finds for a search, asked of our Worker; `none` when Tenor found none, null when no
 * answer came. The words go in the body, as `/yt`'s do (client/youtube.ts, `searchVideo`).
 */
export async function searchGif(query: string): Promise<string | 'none' | null> {
  try {
    const r = await fetch('/gif-search', { method: 'POST', body: query, cache: 'no-store', signal: AbortSignal.timeout(SEARCH_WAIT_MS) });
    const answer = r.ok ? ((await r.json()) as { url?: unknown; error?: unknown }) : null;
    return isTenorMedia(answer?.url) ? answer.url : answer?.error === 'none' ? 'none' : null;
  } catch {
    return null;
  }
}

/**
 * The GIF at a Tenor address, as a file named as Tenor names it, or null when it did not come within GIF_WAIT_MS, is no
 * GIF or animated WebP, or is heavier than MAX_GIF_BYTES.
 */
export async function gifFile(url: string): Promise<File | null> {
  try {
    const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(GIF_WAIT_MS) });
    const blob = r.ok ? await r.blob() : null;
    const type = blob?.type.split(';')[0]!.trim().toLowerCase();
    if (!blob || !blob.size || blob.size > MAX_GIF_BYTES || (type !== 'image/gif' && type !== 'image/webp')) return null;
    const named = url.slice(url.lastIndexOf('/') + 1);
    let name = named;
    try { name = decodeURIComponent(named); } catch { /* not percent-encoded as it should be: as it is */ }
    return new File([blob], name, { type });
  } catch {
    return null;
  }
}
