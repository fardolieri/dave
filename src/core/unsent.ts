// My own texts the Room has not brought back yet, kept in the browser so a reload does not lose them (quality ticket 10).
// The page after the reload shows them as waiting and sends them again after its welcome, with the ids they had, so a
// friend who had them already shows them once. Runtime-neutral: plain data and the parser.
import { isTextId, type TextId } from './protocol';

export type UnsentText = { id: TextId; text: string; at: number };
/** By room id. */
export type Unsent = Record<string, UnsentText[]>;

/** Per room, the newest kept: more than this many texts waiting is a room that has not been reachable for long. */
export const UNSENT_MAX = 50;
/** A text older than this is not sent after a reload: a line out of the blue a day later says nothing. */
export const UNSENT_MAX_AGE_MS = 24 * 3600 * 1000;

export function parseUnsent(raw: string | null): Unsent {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Unsent = {};
  for (const [room, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const texts = list.flatMap((t): UnsentText[] => {
      const u = t as Partial<UnsentText> | null;
      return u && typeof u === 'object' && isTextId(u.id) && typeof u.text === 'string' && typeof u.at === 'number' ? [{ id: u.id, text: u.text, at: u.at }] : [];
    });
    if (texts.length) out[room] = texts;
  }
  return out;
}

/** What of a room's stored texts goes out again after a load: the newest, not too old. */
export const stillToSend = (texts: UnsentText[], now: number): UnsentText[] =>
  texts.filter((t) => now - t.at < UNSENT_MAX_AGE_MS).slice(-UNSENT_MAX);
