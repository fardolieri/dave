// A YouTube link's card, made by the sender's browser as the link comes into the composer (core/youtube.ts): YouTube's
// thumbnail as a picture to send, and the title and channel from its oEmbed answer. Both let any page read them (CORS).
// Friends' apps show the picture they pull from the sender, so only the sender's browser asks YouTube, until a friend
// presses play.
import { aboutVideo, isVideoId, type VideoCard } from '../core/youtube';

/** How long the sender's browser waits for YouTube before the link goes without a card. */
const CARD_WAIT_MS = 10_000;

/**
 * The card for a video, or null when YouTube's thumbnail did not come within CARD_WAIT_MS. A Short has an upright
 * thumbnail, 1080 by 1920, which no other video has: its card is upright, as its picture is. Any other's thumbnail is the
 * 1280 px one, which only videos uploaded in HD have, else the 480 px one every video has; for a video that is gone, that
 * is YouTube's grey placeholder. A title and channel that did not come in that time are left out.
 */
export async function videoCard(id: string): Promise<{ picture: File; card: VideoCard } | null> {
  // One wait for all of it, the second thumbnail and reading the picture included: Send waits for the card.
  const signal = AbortSignal.timeout(CARD_WAIT_MS);
  const get = (url: string) => fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  const thumbnail = (size: string) => get(`https://i.ytimg.com/vi/${id}/${size}.jpg`);
  const jpeg = (blob: Blob | null) => (blob && blob.type.startsWith('image/jpeg') && blob.size ? blob : null);
  try {
    // The pictures read as soon as they come, before the wait for the title can run out and end their reading too.
    const upright = thumbnail('oardefault').then((r) => (r.ok ? r.blob() : null)).catch(() => null);
    const wide = thumbnail('maxresdefault').then((r) => (r.ok ? r : thumbnail('hqdefault'))).then((r) => r.blob());
    wide.catch(() => undefined); // not waited for when the upright one came
    const [tall, about] = await Promise.all([
      upright.then(jpeg),
      get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const blob = tall ?? jpeg(await wide);
    if (!blob) return null;
    return { picture: new File([blob], `youtube-${id}.jpg`, { type: 'image/jpeg' }), card: { id, ...aboutVideo(about) } };
  } catch {
    return null;
  }
}

/** How long the sender's app waits for the Worker's search (worker/ytsearch.ts), which waits for YouTube up to 8 s. */
const SEARCH_WAIT_MS = 10_000;

/**
 * The first video YouTube finds for a search, asked of our Worker (`/yt`, core/youtube.ts); `none` when YouTube found
 * none, null when no answer came. The words go in the body, which Cloudflare's logs of the Worker do not keep, as they
 * keep its addresses: they are a text's, sealed for friends alone.
 */
export async function searchVideo(query: string): Promise<string | 'none' | null> {
  try {
    const r = await fetch('/yt-search', { method: 'POST', body: query, cache: 'no-store', signal: AbortSignal.timeout(SEARCH_WAIT_MS) });
    const answer = r.ok ? ((await r.json()) as { id?: unknown; error?: unknown }) : null;
    return isVideoId(answer?.id) ? answer.id : answer?.error === 'none' ? 'none' : null;
  } catch {
    return null;
  }
}
