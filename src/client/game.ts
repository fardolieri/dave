// The room's games (core/game.ts, ADR 0014): which games its call plays, who plays each, and the one I play. Every
// player declares the game they are in; of each kind, the one started first is the call's, and whoever is in another of
// that kind moves over to it. Games of different kinds go on side by side: some friends play Bonk while others play
// Clink. One per room, beside its call (client/call.ts) and its watch party (client/party.ts). The game itself runs
// elsewhere (client/bonk.ts), over links to the other players of mine (client/gamelinks.ts) that this keeps to who plays.
import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import type { LocalIdentity } from './identity';
import { currents, sameGame, type Game, type GameName } from '../core/game';
import { toBase64Url } from '../core/identity';
import { openGame, sealGame } from '../core/sealed';
import type { createRoom } from './room';

type Room = ReturnType<typeof createRoom>;

export function createGame(room: Room, identity: LocalIdentity, textKey: CryptoKey, inCall: () => boolean) {
  const me = identity.publicKey;
  /** Each friend's game as opened, by the sealed text it came as: the same text is opened once. */
  const opened = new Map<string, Promise<Game | null>>();
  const [games, setGames] = createSignal<ReadonlyMap<string, Game>>(new Map(), { equals: (a, b) => a.size === b.size && [...a].every(([key, g]) => b.get(key) === g) });
  /** Every participant's sealed game, in the order presence lists them: anew only when one of them declares another. */
  const declared = createMemo(() => room.people().filter((p) => p.role === 'participant' && p.game).map((p) => [p.publicKey, p.game!] as const), {
    equals: (a, b) => a.length === b.length && a.every(([key, sealed], i) => key === b[i]![0] && sealed === b[i]![1]),
  });
  createEffect(declared, (entries) => {
    let stale = false;
    void Promise.all(entries.map(async ([key, sealed]) => {
      const id = `${key}:${sealed}`;
      let g = opened.get(id);
      if (!g) { g = openGame({ key: textKey, roomId: room.roomId, from: key, sealed }); opened.set(id, g); }
      return [key, await g] as const;
    })).then((all) => {
      if (stale) return;
      const next = new Map<string, Game>();
      for (const [key, g] of all) if (g) next.set(key, g);
      setGames(next);
      for (const id of opened.keys()) if (!entries.some(([key, sealed]) => id === `${key}:${sealed}`)) opened.delete(id);
    });
    return () => { stale = true; };
  });
  /** The game I declared last; null for none. */
  const [mine, setMine] = createSignal<Game | null>(null);
  /** The call's games, one of each kind anyone plays (in `GAME_NAMES` order); mine included before the Room brings it back. */
  const all = createMemo((): Game[] => {
    const theirs = [...games().entries()].filter(([key]) => key !== me).map(([, g]) => g);
    const own = mine();
    return currents(own ? [...theirs, own] : theirs);
  }, { equals: (a, b) => a.length === b.length && a.every((g, i) => sameGame(g, b[i]!)) });
  /** The call's game of a kind; null while nobody plays one. */
  const of = (name: GameName): Game | null => all().find((g) => g.game === name) ?? null;
  /** Who plays the call's game of a kind: friends in the call who declare it, and me while I do. */
  const membersOf = (name: GameName): string[] => {
    const g = of(name);
    if (!g) return [];
    const keys = [...games().entries()].filter(([key, d]) => key !== me && sameGame(d, g)).map(([key]) => key);
    const own = mine();
    return own && sameGame(own, g) ? [...keys, me] : keys;
  };
  /** The call's game of the kind I play: mine, unless I am to move over to another of its kind. */
  const ofMine = createMemo((): Game | null => { const own = mine(); return own ? of(own.game) : null; }, { equals: sameGame });
  /** Who plays mine. */
  const members = createMemo((): string[] => { const own = mine(); return own ? membersOf(own.game) : []; }, { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });

  let sealing = 0;
  const declare = (g: Game | null): void => {
    setMine(g);
    const n = ++sealing;
    if (!g) { room.declare({ t: 'game' }); return; }
    void sealGame({ key: textKey, privateKey: identity.keys.privateKey, roomId: room.roomId, from: me, game: g }).then(
      (sealed) => { if (n === sealing) room.declare({ t: 'game', sealed }); },
      (e: unknown) => console.error('sealing the game failed', e),
    );
  };
  // Two of a kind started at once: whoever is in the later one moves over to the first.
  createEffect(ofMine, (g) => { const own = untrack(mine); if (own && g && !sameGame(own, g)) declare(g); });
  // Out of the call, out of the game: the Room forgets it with my place in the call.
  createEffect(inCall, (on) => { if (!on && untrack(mine)) { setMine(null); sealing++; } });
  // The links follow who plays: to every other player while I play, to nobody when I do not.
  createEffect(() => ({ g: mine(), m: members() }), ({ g, m }) => { room.gameLinks.play(g ? g.id : null, m); });
  onCleanup(() => room.gameLinks.play(null, []));

  return {
    /** The call's games, one of each kind anyone plays, in `GAME_NAMES` order. */
    games: all,
    /** The kinds of game the call plays, in that order. */
    names: createMemo((): GameName[] => all().map((g) => g.game), { equals: (a, b) => a.length === b.length && a.every((n, i) => n === b[i]) }),
    of,
    membersOf,
    /** The kind of game I play; null for none. */
    playing: (): GameName | null => mine()?.game ?? null,
    /** The game I play, as I declare it; null for none. */
    mine: (): Game | null => mine(),
    /** Starts `name` for the call, unless one of that kind goes on already: I join that instead. Out of mine, if I play another. */
    start: (name: GameName): void => {
      if (!inCall()) return;
      const going = untrack(() => of(name));
      if (going) { declare(going); return; }
      declare({ game: name, id: toBase64Url(crypto.getRandomValues(new Uint8Array(6))), at: Math.round(room.roomNow() ?? Date.now()) });
    },
    /** Into the call's game of a kind; out of mine, if I play another. */
    join: (name: GameName): void => { const g = untrack(() => of(name)); if (g && inCall()) declare(g); },
    /** Out of mine; it goes on for whoever else plays. */
    leave: (): void => { if (untrack(mine)) declare(null); },
    links: room.gameLinks,
    me,
  };
}
export type GameHandle = ReturnType<typeof createGame>;
