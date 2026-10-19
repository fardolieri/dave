// My own texts the Room has not brought back yet, kept in the browser so a reload does not lose them (quality ticket 10).
// The page after the reload shows them as waiting and sends them again after its welcome, with the ids they had, so a
// friend who had them already shows them once. Runtime-neutral: plain data and the parser.
import { identityOf, isIdentity, isTextId, type Identity, type TextId } from './protocol';

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

/**
 * My private texts (ADR 0007) not back from the Room yet, by room id, with the friend each is for: kept apart from the
 * room's, so that an app from before, which knows no `to`, cannot send one to the whole room. Sealed again after a reload,
 * once the Room lists the friend.
 */
/** `out`: it went out to the Room before, unanswered, so the friend may have it. */
export type UnsentPrivate = { id: TextId; to: Identity; text: string; at: number; out?: true };
export function parseUnsentPrivate(raw: string | null): Record<string, UnsentPrivate[]> {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, UnsentPrivate[]> = {};
  for (const [room, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const texts = list.flatMap((t): UnsentPrivate[] => {
      const u = t as Partial<UnsentPrivate> | null;
      if (!u || typeof u !== 'object' || !isTextId(u.id) || typeof u.text !== 'string' || typeof u.at !== 'number' || !isIdentity(u.to)) return [];
      return [{ id: u.id, to: identityOf(u.to), text: u.text, at: u.at, ...(u.out === true ? { out: true as const } : {}) }];
    });
    if (texts.length) out[room] = texts;
  }
  return out;
}

/** Whether a text has waited too long to be sent (UNSENT_MAX_AGE_MS). */
export const tooOld = (t: UnsentText, now: number): boolean => now - t.at >= UNSENT_MAX_AGE_MS;
