// A watch party: a YouTube video from the room's chat that friends in the call watch together, in step, each in a player
// of their own. Anyone in it plays, pauses, seeks, changes the speed or puts another card of the chat on. Only its state
// travels: each friend in it declares the party as they last took it, sealed for the room, in presence (`party`,
// core/protocol.ts), and the latest change anyone declares is the party's (`current`). Runtime-neutral: plain data only.
import { isVideoId } from './youtube';

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
  /** The YouTube card it plays: its file's hash (core/attachment.ts), so a party plays only a video of the chat. */
  hash: string;
  /** The card's video, as its announcement says. */
  video: string;
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
};

/** The longest party a client seals, as JSON: a key of 87 characters and a hash of 43, the rest small numbers. */
export const MAX_PARTY_BODY_BYTES = 512;
const KEY = /^[A-Za-z0-9_-]{87}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;

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
  return { n: p.n!, by: p.by, hash: p.hash, video: p.video, playing: p.playing, pos: p.pos, rate: p.rate, at: p.at! };
}

/** The party as it is sealed: always the same fields in the same order, so the same state seals to the same text. */
export const partyText = (p: Party): string =>
  JSON.stringify({ n: p.n, by: p.by, hash: p.hash, video: p.video, playing: p.playing, pos: Math.round(p.pos * 1000) / 1000, rate: p.rate, at: p.at });

/** Whether `a` is a later change than `b`: made later, else counted higher, else made by the greater key. */
export const later = (a: Party, b: Party): boolean => a.at > b.at || (a.at === b.at && (a.n > b.n || (a.n === b.n && a.by > b.by)));

/**
 * The same change: what a friend who took it declares again is no newer. Its time too: a party started again after one
 * ended counts from 1 again, maybe by the same friend.
 */
export const sameChange = (a: Party | null, b: Party | null): boolean => (a === null || b === null ? a === b : a.n === b.n && a.by === b.by && a.at === b.at);

/** The party's state: the latest change anyone in it declares; null when nobody is in one. */
export function current(declared: Iterable<Party>): Party | null {
  let newest: Party | null = null;
  for (const p of declared) if (newest === null || later(p, newest)) newest = p;
  return newest;
}

/** Where the video is at `now` (the Room's clock), in seconds, as the party has it. */
export const positionAt = (p: Party, now: number): number => (p.playing ? p.pos + (Math.max(0, now - p.at) / 1000) * p.rate : p.pos);

/**
 * A change I make: one more than the latest I have seen, made by me now; never before it, though my idea of the Room's
 * clock may be behind the friend's who made it.
 */
export function change(from: Party | null, me: string, now: number, to: Pick<Party, 'hash' | 'video' | 'playing' | 'pos' | 'rate'>): Party {
  const at = from ? Math.max(Math.round(now), from.at + 1) : Math.round(now);
  return { n: (from?.n ?? 0) + 1, by: me, hash: to.hash, video: to.video, playing: to.playing, pos: Math.max(0, to.pos), rate: to.rate, at };
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
