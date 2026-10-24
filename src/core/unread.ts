/**
 * Unread counts kept over a reload: by room id (`dave.unreadRooms`) and by friend (`dave.unreadPrivate`), texts that came
 * while the room or the conversation was not on screen. Kept as the counts themselves: what they count is in the
 * histories already, which a reload reads back without telling new from old.
 */
export type Counts = Record<string, number>;

/** Each room's own look, by room id (`dave.roomThemes`): a theme's file name, or '' for the default look. */
export function parseRoomThemes(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** A stored map of counts; anything that is not a whole number above 0 is left out. */
export function parseCounts(raw: string | null): Counts {
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Counts = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[k] = n;
  return out;
}
