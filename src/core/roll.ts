// Rolling: a `/yt` or `/gif` text whose video or GIF is on the way says so under it, in every friend's log, until it comes
// (core/youtube.ts, core/gif.ts). Nobody knows what comes until it does, the sender neither: a little gamble.
import { gifSearchOf } from './gif';
import { videoSearchOf } from './youtube';

/** What a text rolls for, and its search: a video with `/yt`, a GIF with `/gif`; null for neither. */
export function rollOf(text: string): { kind: 'video' | 'gif'; search: string } | null {
  const video = videoSearchOf(text);
  if (video) return { kind: 'video', search: video };
  const gif = gifSearchOf(text);
  return gif ? { kind: 'gif', search: gif } : null;
}

/**
 * How long a `/yt` or `/gif` text says what it rolled for is on the way, at most: the sender's app waits up to 10 s for the
 * search and 10 s for the card or the GIF (client/youtube.ts, client/gif.ts), and the file is then made ready, sealed and
 * relayed.
 */
export const ROLL_WAIT_MS = 25_000;
/** A line of a log as `rollsWaiting` reads it (client/room.ts, `ChatLine`). */
type LogLine =
  | { kind: 'text'; id: string; from: { publicKey: string }; text: string; at: number }
  | { kind: 'file'; from: { publicKey: string }; file: { youtube?: unknown; gif?: unknown }; at: number }
  | { kind: 'system'; roll?: string };

/**
 * The `/yt` and `/gif` texts of a log whose video or GIF is still on the way, as every app tells it from the log alone, a
 * friend's from before too; `now` on the Room's clock, which the lines' `at` are. A `/yt` text waits until a YouTube card
 * from its writer comes after it, a `/gif` text until a GIF of hers does, each answering the oldest of hers of its kind that
 * still waited when it came; in the writer's own log (`me`), until her app says it sent none (a system line whose `roll` is
 * the text's id, client/room.ts, which its line's id ends with: `<key>:id` once the Room brought it back, the key my own or
 * a room of two's, `pending:id` before); and at most ROLL_WAIT_MS from when it was written, so one whose file never comes
 * (its writer's page closed, none found) stops. A link's card from the writer meanwhile answers a `/yt` too. `next`: when
 * the next one stops waiting by the clock.
 */
export function rollsWaiting(lines: readonly LogLine[], me: string, now: number): { ids: ReadonlySet<string>; next: number | null } {
  const ended = new Set(lines.flatMap((l) => (l.kind === 'system' && l.roll ? [l.roll] : [])));
  /** By kind and writer. */
  const waiting = new Map<string, Array<{ id: string; at: number }>>();
  for (const l of lines) {
    if (l.kind === 'text') {
      const kind = rollOf(l.text)?.kind;
      if (!kind || (l.from.publicKey === me && ended.has(l.id.slice(l.id.lastIndexOf(':') + 1)))) continue;
      const key = `${kind} ${l.from.publicKey}`;
      let hers = waiting.get(key);
      if (!hers) waiting.set(key, (hers = []));
      hers.push({ id: l.id, at: l.at });
    } else if (l.kind === 'file') {
      const kind = l.file.youtube ? 'video' : l.file.gif ? 'gif' : null;
      const hers = kind ? waiting.get(`${kind} ${l.from.publicKey}`) : undefined;
      while (hers?.length && hers[0]!.at + ROLL_WAIT_MS < l.at) hers.shift(); // done waiting before this file came
      hers?.shift();
    }
  }
  const ids = new Set<string>();
  let next: number | null = null;
  for (const w of [...waiting.values()].flat()) {
    if (now >= w.at + ROLL_WAIT_MS) continue;
    ids.add(w.id);
    next = Math.min(next ?? Infinity, w.at + ROLL_WAIT_MS);
  }
  return { ids, next };
}

/** Whether two answers of `rollsWaiting` say the same. */
export const sameRolls = (a: ReturnType<typeof rollsWaiting>, b: ReturnType<typeof rollsWaiting>): boolean =>
  a.next === b.next && a.ids.size === b.ids.size && [...a.ids].every((id) => b.ids.has(id));
