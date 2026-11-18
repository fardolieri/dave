// YouTube links put into the composer: which video a link names, and what its card says. The card goes as a picture,
// YouTube's thumbnail, whose announcement names the video too (core/attachment.ts, `youtube`): a friend's app shows it
// with a play button that puts the video's player in its place, and an app from before shows the picture.
import { parseBlocks, type Block } from './markdown';

/** A video's id as YouTube writes it: 11 characters of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const isVideoId = (v: unknown): v is string => typeof v === 'string' && VIDEO_ID.test(v);
/** The longest title and channel name a card carries, in UTF-16 units: YouTube's own limit for a title is 100. */
export const MAX_VIDEO_TITLE = 100;
export const MAX_VIDEO_CHANNEL = 100;

/** What a card for a video says: the video, and its title and channel when YouTube told them. */
export type VideoCard = { id: string; title?: string; channel?: string };

/** The video a link names, or null: youtube.com/watch?v=…, youtu.be/…, /shorts/…, /live/…, /embed/…, on m. and music. too. */
export function videoOf(link: string): string | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const [first, second] = url.pathname.split('/').filter(Boolean);
  let id: string | null | undefined = null;
  if (host === 'youtu.be') id = first;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') id = first === 'watch' ? url.searchParams.get('v') : ['shorts', 'live', 'embed'].includes(first ?? '') ? second : null;
  // An embedded playlist's address, not a video's, though as long as an id.
  return isVideoId(id) && id !== 'videoseries' ? id : null;
}

/** The videos a text links to, each once, in order: its links as the log shows them (core/markdown.ts), so none in code. */
export function videosIn(text: string): string[] {
  if (!/youtu/i.test(text)) return []; // read as the composer's text changes: most of it has no link to YouTube
  const out = new Set<string>();
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'quote') walk(b.blocks);
      else if (b.kind === 'text') for (const line of b.lines) for (const run of line) { const id = run.href ? videoOf(run.href) : null; if (id) out.add(id); }
    }
  };
  walk(parseBlocks(text));
  return [...out];
}

/** At most `max` UTF-16 units of `s`, trimmed, never half an emoji; undefined when nothing is left. */
function cut(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  let out = s.trim().slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out.trim() || undefined;
}

/** The title and channel from YouTube's oEmbed answer, cut to what a card carries; whatever is missing is left out. */
export function aboutVideo(raw: unknown): { title?: string; channel?: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const title = cut(o.title, MAX_VIDEO_TITLE);
  const channel = cut(o.author_name, MAX_VIDEO_CHANNEL);
  return { ...(title ? { title } : {}), ...(channel ? { channel } : {}) };
}

/** A card as a friend's app wrote it, or null for anything off. */
export function parseVideoCard(raw: unknown): VideoCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (!isVideoId(c.id)) return null;
  const card: VideoCard = { id: c.id };
  for (const [key, max] of [['title', MAX_VIDEO_TITLE], ['channel', MAX_VIDEO_CHANNEL]] as const) {
    const v = c[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > max) return null;
    card[key] = v;
  }
  return card;
}

/** The longest search `/yt` asks YouTube for, in UTF-16 units: the rest of a longer one is left out. */
export const MAX_VIDEO_SEARCH = 100;

/**
 * What a text asks YouTube for with `/yt`, or null when it asks for nothing: `/yt rick roll` sends as it is, and the sender's
 * app sends the first video YouTube finds for "rick roll" after it, whatever that turns out to be. Its words on one line.
 */
export function videoSearchOf(text: string): string | null {
  const m = /^\/yt\s+(\S[\s\S]*)$/i.exec(text.trim());
  return m ? normalSearch(m[1]!) : null;
}

/** A search's words on one line, at most MAX_VIDEO_SEARCH units of them; null for none. */
export const normalSearch = (words: string): string | null => cut(words.replace(/\s+/g, ' '), MAX_VIDEO_SEARCH) ?? null;

/**
 * A video among YouTube's results, in either of the two layouts it served on 2026-11-17, about one page in eight the
 * newer: a `videoRenderer` named by its `videoId`, or a `lockupViewModel` by its `contentId`, of the type a video's is.
 * Ads are renderers of other names.
 */
const RESULT = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"|"contentId":"([A-Za-z0-9_-]{11})","contentType":"LOCKUP_CONTENT_TYPE_VIDEO"/;

/**
 * The first video on a page of YouTube's search results, in the order shown; null when YouTube says it found none (its
 * EMPTY_SEARCH icon, "No results found"); undefined for anything else, a page that is no page of results (a bot check, a
 * consent page) or one laid out anew, so that the Worker says YouTube did not answer, and logs it (worker/ytsearch.ts).
 * Read without parsing the page, which is a megabyte.
 */
export function firstVideoIn(page: string): string | null | undefined {
  const m = RESULT.exec(page);
  if (m) return m[1] ?? m[2];
  return page.includes('"iconType":"EMPTY_SEARCH"') ? null : undefined;
}
