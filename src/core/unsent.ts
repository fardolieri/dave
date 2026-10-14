// My own texts the Room has not brought back yet, kept in the browser so a reload does not lose them (quality ticket 10).
// The page after the reload shows them as waiting and sends them again after its welcome, with the ids they had, so a
// friend who had them already shows them once. Runtime-neutral: plain data and the parser.
import { isTextId, type TextId } from './protocol';

export type UnsentText = { id: TextId; text: string; at: number };
/** By room id. */
export type Unsent = Record<string, UnsentText[]>;

/**
 * Per room, the newest kept over a reload. Below the Room's burst of 40 frames (core/ratelimit.ts), which the welcome
 * also spends on what it declares again: more at once would come back refused.
 */
export const UNSENT_MAX = 30;
/** A text waiting longer than this is not sent any more, reload or not: a line out of the blue a day later says nothing. */
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

/** Whether a text has waited too long to be sent (UNSENT_MAX_AGE_MS). */
export const tooOld = (t: UnsentText, now: number): boolean => now - t.at >= UNSENT_MAX_AGE_MS;
