import { authKeyOf, DEFAULT_ROOM_NAME, roomIdOf, type InviteLink } from '../core/rooms';
import { adoptLegacyHistory } from './history';
import { local } from './storage';

/**
 * The rooms this browser has entered, oldest first (ADR 0004). Only the secret and the name from the
 * invite link are stored; the id on the wire and the auth key are derived again at load. Which room is
 * selected is remembered too, so a reload lands where you were.
 */
export type SavedRoom = { id: string; authKey: string; secret: string; name: string; addedAt: number };
type Stored = Pick<SavedRoom, 'secret' | 'name' | 'addedAt'>;
const KEY = 'rooms';
const SELECTED = 'room';
/** The single secret from before rooms; folded into the list on first load and removed. */
const LEGACY_SECRET = 'secret';

function readStored(): Stored[] {
  try {
    const list = JSON.parse(local.get(KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((r): r is Stored => !!r && typeof r.secret === 'string' && typeof r.name === 'string' && typeof r.addedAt === 'number') : [];
  } catch { return []; }
}

function write(list: Stored[]): void {
  local.set(KEY, JSON.stringify(list.map(({ secret, name, addedAt }) => ({ secret, name, addedAt }))));
}

async function withKeys(r: Stored): Promise<SavedRoom> {
  return { ...r, id: await roomIdOf(r.secret), authKey: await authKeyOf(r.secret) };
}

export async function loadRooms(): Promise<SavedRoom[]> {
  let stored = readStored();
  const legacy = local.get(LEGACY_SECRET);
  if (legacy) {
    if (!stored.some((r) => r.secret === legacy)) stored = [{ secret: legacy, name: DEFAULT_ROOM_NAME, addedAt: Date.now() }, ...stored];
    write(stored);
    local.remove(LEGACY_SECRET);
    await adoptLegacyHistory(await roomIdOf(legacy));
  }
  return Promise.all(stored.map(withKeys));
}

/** Adds a room from an invite link, or takes the link's name for a room already known. Persists. */
export async function addRoom(rooms: SavedRoom[], link: InviteLink): Promise<SavedRoom[]> {
  const known = rooms.find((r) => r.secret === link.secret);
  const next = known
    ? rooms.map((r) => (r === known && r.name !== link.name ? { ...r, name: link.name } : r))
    : [...rooms, await withKeys({ secret: link.secret, name: link.name, addedAt: Date.now() })];
  write(next);
  return next;
}

export function forgetRoom(rooms: SavedRoom[], secret: string): SavedRoom[] {
  const next = rooms.filter((r) => r.secret !== secret);
  write(next);
  return next;
}

export const getSelectedRoom = (): string | null => local.get(SELECTED);
export const setSelectedRoom = (secret: string): void => local.set(SELECTED, secret);
