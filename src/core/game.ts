// A game: a little game friends in the call play together, started from the call in one click (ADR 0014). One at a time
// per call. Each player declares the game they are in, sealed for the room, in presence (`game`, core/protocol.ts), as a
// watch party is declared (ADR 0012): the server learns that a friend plays, not what. Everything that moves in a game
// goes from player to player over game links (client/gamelinks.ts), never through the server. Runtime-neutral: plain
// data only.

/** The games there are. A name an app does not know is a game it cannot play: it shows nothing for it. */
export const GAME_NAMES = ['bonk'] as const;
export type GameName = (typeof GAME_NAMES)[number];
export const isGameName = (v: unknown): v is GameName => typeof v === 'string' && (GAME_NAMES as readonly string[]).includes(v);

/** A game as a player declares it: which one, and the one round of it they are in. */
export type Game = {
  game: GameName;
  /** Tells this game from one started after it ended: chosen at random by whoever started it. */
  id: string;
  /** When it was started, by the Room's clock (ms). Of two games started at once, the first is the call's (`current`). */
  at: number;
};

const ID = /^[A-Za-z0-9_-]{8}$/;
export const isGameId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** The longest game a client seals, as JSON: the name, an id, the time; with room to spare for a game named longer. */
export const MAX_GAME_BODY_BYTES = 128;

/** A game as a friend's app sealed it, or null for anything off, a game this app does not know too. */
export function parseGame(text: string): Game | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const g = v as Partial<Game> | null;
  if (!g || typeof g !== 'object' || !isGameName(g.game) || !isGameId(g.id) || !Number.isSafeInteger(g.at) || g.at! < 0) return null;
  return { game: g.game, id: g.id, at: g.at! };
}

/** The game as it is sealed: always the same fields in the same order. */
export const gameText = (g: Game): string => JSON.stringify({ game: g.game, id: g.id, at: g.at });

export const sameGame = (a: Game | null, b: Game | null): boolean => (a === null || b === null ? a === b : a.game === b.game && a.id === b.id && a.at === b.at);

/**
 * The call's game, of all its players declare: the one most of them play, then the one started first, then the smaller
 * id, the same for everyone. Whoever is in another moves over to it (client/game.ts): two friends who start one at the
 * same moment end up in the first, and a friend whose socket was away a while, back with a game that ended meanwhile,
 * moves over to the one the others started since, rather than pull them all back into theirs.
 */
export function current(declared: Iterable<Game>): Game | null {
  const all = [...declared];
  const players = (g: Game): number => all.filter((d) => sameGame(d, g)).length;
  let best: Game | null = null;
  for (const g of all) {
    if (best === null) { best = g; continue; }
    const more = players(g) - players(best);
    if (more > 0 || (more === 0 && (g.at < best.at || (g.at === best.at && g.id < best.id)))) best = g;
  }
  return best;
}

/**
 * A game link's name, as its `link` frames carry it (core/protocol.ts, `LinkData`): a file link's is hex, so the two
 * never meet. One link per two players of a game.
 */
export const gameLinkId = (g: Pick<Game, 'id'>): string => `game-${g.id}`;
/** The game id of a game link's name; null for a file link's. */
export const gameOfLink = (link: string): string | null => (link.startsWith('game-') && isGameId(link.slice(5)) ? link.slice(5) : null);
