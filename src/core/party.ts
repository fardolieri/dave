// A watch party: a YouTube video from the room's chat that friends in the call watch together, in step, each in a player
// of their own. Anyone in it plays, pauses, seeks, changes the speed or puts another card of the chat on. Only its state
// travels: each friend in it declares the party as they last took it, sealed for the room, in presence (`party`,
// core/protocol.ts), and the latest change anyone declares is the party's (`current`). Runtime-neutral: plain data only.
import { MAX_VIDEO_TITLE, isVideoId } from './youtube';

/**
 * A party's state, as set by the last friend who changed it. Where the video is (`pos`, in seconds) is said for a moment,
 * `at`, by the Room's clock, which every friend's app knows as of its last welcome: a friend who takes it later, or
 * comes in later, starts from where it is by then.
 */
export type Party = {
  /** Counts the changes: each is one more than the latest the friend making it had seen. Of two at the same `at`, the higher counts. */
  n: number;
  /** Who made this change (their public key): of two at the same time and count, the greater key's counts. */
  by: string;
  /** The YouTube card it plays: its file's hash (core/attachment.ts), so a party starts only from a video of the chat. */
  hash: string;
  /** The card's video, as its announcement says. */
  video: string;
  /**
   * The card's title, when it has one: for a friend whose chat does not have the card (new to the room since it was
   * sent, ADR 0009), whose tile shows the party by it. An app from before neither writes nor keeps it.
   */
  title?: string;
  playing: boolean;
  /** Where the video was at `at`, in seconds. */
  pos: number;
  /** YouTube's playback rate, 0.25 to 2: its menu's steps, or its custom speed's, in hundredths. */
  rate: number;
  /**
   * When, by the Room's clock (ms): the latest change is the one made last. Not the count alone: a friend whose socket
   * was gone a while declares the party as it was then, which must not take over one started meanwhile.
   */
  at: number;
  /**
   * What plays next, in order (`MAX_QUEUE` at most): when the video ends, the first goes on, playing, and leaves it. An
   * app from before neither writes nor keeps it; this app writes it always, empty too, so a change without one is told
   * for an old app's (`current`, client/party.ts).
   */
  queue?: Queued[];
};

/**
 * A video waiting in the party's queue: a YouTube card of the chat, as the party names one. `id` tells two entries of the
 * same card apart. `by` is the start of the key of the friend who put it there, enough to find their face among the
 * friends in the room; the whole key would not leave room for the queue in a socket's attachment (worker/room.ts).
 * `title` is the card's, cut to `MAX_QUEUED_TITLE_BYTES`, for a friend whose chat does not have the card.
 */
export type Queued = { id: string; by: string; hash: string; video: string; title?: string };

/** How many videos the queue holds at most (owner, 2026-11-17). */
export const MAX_QUEUE = 20;
/**
 * How much of a card's title a queued video carries, in bytes as JSON writes it: a line of the list (60 letters of a
 * Latin script, 30 of a CJK one), and room for twenty in a socket's attachment.
 */
export const MAX_QUEUED_TITLE_BYTES = 90;
/** How much of the key of whoever queued a video the entry carries. */
export const QUEUED_BY_LENGTH = 11;

/**
 * The longest party a client seals, as JSON: a key of 87 characters and a hash of 43, a title of up to 100 UTF-16 units
 * (each up to 6 bytes as JSON writes it, `\u0001`), the rest small numbers; and a full queue, each title of which is up
 * `MAX_QUEUED_TITLE_BYTES` at most. Worker and client alike, a sealed one must fit a socket's attachment (16 KiB, with
 * everything else the Room keeps there: test/party.test.ts).
 */
export const MAX_PARTY_BODY_BYTES = 5560;
const KEY = /^[A-Za-z0-9_-]{87}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const QUEUED_ID = /^[A-Za-z0-9_-]{8}$/;
const QUEUED_BY = new RegExp(`^[A-Za-z0-9_-]{${QUEUED_BY_LENGTH}}$`);
/** What JSON writes longer than a character's UTF-8: control characters, a lone half of a surrogate pair (`u`: a pair is one). */
const LONG_IN_JSON = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/gu;
const UTF8 = new TextEncoder();

/**
 * A card's title as a queued video carries it: what JSON writes longer than a character's UTF-8 left out, then as many
 * whole characters as fit `MAX_QUEUED_TITLE_BYTES` as JSON writes them; none when nothing is left.
 */
export function queuedTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  let out = '';
  let bytes = 0;
  for (const c of title.replace(LONG_IN_JSON, ' ').trim()) {
    const b = c === '"' || c === '\\' ? 2 : UTF8.encode(c).length;
    if (bytes + b > MAX_QUEUED_TITLE_BYTES) break;
    out += c;
    bytes += b;
  }
  return out.trim() || undefined;
}

function parseQueued(v: unknown): Queued | null {
  const q = v as Partial<Queued> | null;
  if (!q || typeof q !== 'object') return null;
  if (typeof q.id !== 'string' || !QUEUED_ID.test(q.id) || typeof q.by !== 'string' || !QUEUED_BY.test(q.by)) return null;
  if (typeof q.hash !== 'string' || !HASH.test(q.hash) || !isVideoId(q.video)) return null;
  if (q.title !== undefined && (typeof q.title !== 'string' || queuedTitle(q.title) !== q.title)) return null;
  return { id: q.id, by: q.by, hash: q.hash, video: q.video, ...(q.title === undefined ? {} : { title: q.title }) };
}

/** A party as a friend's app sealed it, or null for anything off. */
export function parseParty(text: string): Party | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const p = v as Partial<Party> | null;
  if (!p || typeof p !== 'object') return null;
  if (!Number.isSafeInteger(p.n) || p.n! < 1) return null;
  if (typeof p.by !== 'string' || !KEY.test(p.by) || typeof p.hash !== 'string' || !HASH.test(p.hash) || !isVideoId(p.video)) return null;
  if (typeof p.playing !== 'boolean' || typeof p.pos !== 'number' || !Number.isFinite(p.pos) || p.pos < 0) return null;
  if (typeof p.rate !== 'number' || !(p.rate >= 0.25 && p.rate <= 2) || !Number.isSafeInteger(p.at) || p.at! < 0) return null;
  if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length === 0 || p.title.length > MAX_VIDEO_TITLE)) return null;
  let queue: Queued[] | undefined;
  if (p.queue !== undefined) {
    if (!Array.isArray(p.queue) || p.queue.length > MAX_QUEUE) return null;
    queue = [];
    for (const v of p.queue as unknown[]) { const q = parseQueued(v); if (!q || queue.some((x) => x.id === q.id)) return null; queue.push(q); }
  }
  return { n: p.n!, by: p.by, hash: p.hash, video: p.video, ...(p.title === undefined ? {} : { title: p.title }), playing: p.playing, pos: p.pos, rate: p.rate, at: p.at!, ...(queue ? { queue } : {}) };
}

/** The party as it is sealed: always the same fields in the same order, so the same state seals to the same text. */
export const partyText = (p: Party): string =>
  JSON.stringify({ n: p.n, by: p.by, hash: p.hash, video: p.video, title: p.title, playing: p.playing, pos: Math.round(p.pos * 1000) / 1000, rate: p.rate, at: p.at, queue: p.queue && queueOrder(p.queue) });

/** The queue's entries with their fields in the same order, whatever order they were made in. */
const queueOrder = (queue: Queued[]): Queued[] => queue.map((q) => ({ id: q.id, by: q.by, hash: q.hash, video: q.video, title: q.title }));

/**
 * The same state: the same change with the same queue. A change declared again may carry a queue its maker's did not:
 * one of an app from before queues, carried on (client/party.ts).
 */
export const sameState = (a: Party | null, b: Party | null): boolean => sameChange(a, b) && sameQueue(a?.queue, b?.queue);

/** Whether two queues are the same, entry for entry; none (from an app before queues) is no queue. */
export const sameQueue = (a: Queued[] | undefined, b: Queued[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(queueOrder(a)) === JSON.stringify(queueOrder(b)));

/** Whether `a` is a later change than `b`: made later, else counted higher, else made by the greater key. */
export const later = (a: Party, b: Party): boolean => a.at > b.at || (a.at === b.at && (a.n > b.n || (a.n === b.n && a.by > b.by)));

/**
 * The same change: what a friend who took it declares again is no newer. Its time too: a party started again after one
 * ended counts from 1 again, maybe by the same friend.
 */
export const sameChange = (a: Party | null, b: Party | null): boolean => (a === null || b === null ? a === b : a.n === b.n && a.by === b.by && a.at === b.at);

/**
 * The party's state: the latest change anyone in it declares; null when nobody is in one. Of copies of the same change,
 * one with a queue: an app from before queues declares the change again without it (client/party.ts), and one of this
 * app's may carry a queue on into an old app's change, which another may have carried on otherwise: the longer of two
 * queues, then the greater, for everyone the same.
 */
export function current(declared: Iterable<Party>): Party | null {
  let newest: Party | null = null;
  for (const p of declared) if (newest === null || later(p, newest) || (sameChange(p, newest) && fuller(p.queue, newest.queue))) newest = p;
  return newest;
}
const fuller = (a: Queued[] | undefined, b: Queued[] | undefined): boolean =>
  a !== undefined && (b === undefined || a.length > b.length || (a.length === b.length && JSON.stringify(queueOrder(a)) > JSON.stringify(queueOrder(b))));

/** Where the video is at `now` (the Room's clock), in seconds, as the party has it. */
export const positionAt = (p: Party, now: number): number => (p.playing ? p.pos + (Math.max(0, now - p.at) / 1000) * p.rate : p.pos);

/**
 * A change I make: one more than the latest I have seen, made by me now; never before it, though my idea of the Room's
 * clock may be behind the friend's who made it.
 */
export function change(from: Party | null, me: string, now: number, to: Pick<Party, 'hash' | 'video' | 'title' | 'playing' | 'pos' | 'rate' | 'queue'>): Party {
  const at = from ? Math.max(Math.round(now), from.at + 1) : Math.round(now);
  return { n: (from?.n ?? 0) + 1, by: me, hash: to.hash, video: to.video, ...(to.title === undefined ? {} : { title: to.title }), playing: to.playing, pos: Math.max(0, to.pos), rate: to.rate, at, queue: to.queue ?? [] };
}

/** The party as it is, at `now`, to change from: where it is by then, the title from my card where I have it. */
export const asIs = (p: Party, now: number, title = p.title): Pick<Party, 'hash' | 'video' | 'title' | 'playing' | 'pos' | 'rate' | 'queue'> =>
  ({ hash: p.hash, video: p.video, title, playing: p.playing, pos: positionAt(p, now), rate: p.rate, queue: p.queue });

/** The queue with `q` put in it: first (play next) or last; null when full. */
export const enqueue = (queue: Queued[], q: Queued, first: boolean): Queued[] | null =>
  queue.length >= MAX_QUEUE ? null : first ? [q, ...queue] : [...queue, q];
/** The queue with the entry `id` moved `by` places on (-1: up, 1: down), as far as it goes. */
export function moveQueued(queue: Queued[], id: string, by: number): Queued[] {
  const i = queue.findIndex((q) => q.id === id);
  const j = Math.max(0, Math.min(queue.length - 1, i + by));
  if (i < 0 || i === j) return queue;
  const out = queue.filter((q) => q.id !== id);
  out.splice(j, 0, queue[i]!);
  return out;
}

/**
 * The next video of the queue put on, from its start, and out of the queue: playing as `playing` says, at the party's
 * speed. Its title is my card's where I have it (`titleOf`), else the queue's. Null with nothing queued.
 */
export function next(p: Party, playing: boolean, titleOf: (q: Queued) => string | undefined): Pick<Party, 'hash' | 'video' | 'title' | 'playing' | 'pos' | 'rate' | 'queue'> | null {
  const [q, ...rest] = p.queue ?? [];
  if (!q) return null;
  return { hash: q.hash, video: q.video, title: titleOf(q) ?? q.title, playing, pos: 0, rate: p.rate, queue: rest };
}

/**
 * How far a player may be from where the party is before it is put there: playing, a second and a half, about what a seek
 * costs; paused, hardly at all, so everyone looks at the same frame.
 */
export const DRIFT_S = 1.5;
export const PAUSED_DRIFT_S = 0.3;
/** How far a player may be off while the party is so. */
export const driftAllowed = (p: Party): number => (p.playing ? DRIFT_S : PAUSED_DRIFT_S);
/**
 * How far a player's video may jump between two of its reports, beyond the time that passed, before the jump is taken
 * for the friend's own seek: a buffering player only falls behind, without jumping.
 */
export const SEEK_JUMP_S = 1.5;

/**
 * Seeks the app asked of a player and has not seen it settle yet: every place it was sent to (a second seek may come
 * before the first is answered), when it was last sent, and where it was before the first. Seconds, ms.
 */
export type Seeking = { to: number[]; from: number; at: number };

/** The seeks asked so far, and one more to `to` now from `position`. */
export const seekMore = (s: Seeking | null, to: number, position: number, now: number): Seeking =>
  s ? { to: [...s.to, to], from: s.from, at: now } : { to: [to], from: position, at: now };

/** Whether a player telling `time` (s) at `now` (ms), playing at `rate`, is at `t`, or as far past it as it could have played since `since`. */
export const atOrPast = (t: number, since: number, time: number, now: number, rate: number): boolean =>
  time > t - SEEK_JUMP_S && time < t + (Math.max(0, now - since) / 1000) * rate + SEEK_JUMP_S;

/**
 * Whether a time the player tells while the app's seeks are under way is theirs: at one of the places they went to, or
 * where it was before them (a report from before). A time anywhere else is the friend's own seek.
 */
export const fromSeeking = (s: Seeking, time: number, now: number, rate: number): boolean =>
  s.to.some((t) => atOrPast(t, s.at, time, now, rate)) || atOrPast(s.from, s.at, time, now, rate);

/** Whether a player that went from `before` to `after` seconds while `elapsed` ms passed at `rate` jumped (a seek). */
export function jumped(before: number, after: number, elapsed: number, playing: boolean, rate: number): boolean {
  // Falling behind while playing is buffering; only a jump back, or ahead past what could have played, is a seek.
  const furthest = playing ? before + (elapsed / 1000) * rate : before;
  return after < before - SEEK_JUMP_S || after > furthest + SEEK_JUMP_S;
}
