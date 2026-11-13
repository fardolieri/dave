// A YouTube link's card, made by the sender's browser as the link comes into the composer (core/youtube.ts): YouTube's
// thumbnail as a picture to send, and the title and channel from its oEmbed answer. Both let any page read them (CORS).
// Friends' apps show the picture they pull from the sender, so only the sender's browser asks YouTube, until a friend
// presses play.
import { aboutVideo, type VideoCard } from '../core/youtube';

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
