// The room's game (core/game.ts, ADR 0014): which game its call plays, who plays it, and my part in it. Every player
// declares the game they are in; the one started first is the call's, and whoever is in another moves over to it. One
// per room, beside its call (client/call.ts) and its watch party (client/party.ts). The game itself runs elsewhere
// (client/bonk.ts), over links to the other players (client/gamelinks.ts) that this keeps to who plays.
import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import type { LocalIdentity } from './identity';
import { current, sameGame, type Game, type GameName } from '../core/game';
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
  /** The call's game: the first started of those anyone plays, mine included before the Room brings it back. */
  const now = createMemo((): Game | null => {
    const all = [...games().entries()].filter(([key]) => key !== me).map(([, g]) => g);
    const own = mine();
    return current(own ? [...all, own] : all);
  }, { equals: sameGame });
  /** Who plays it: friends in the call who declare it, and me while I do. */
  const members = createMemo((): string[] => {
    const g = now();
    if (!g) return [];
    const keys = [...games().entries()].filter(([key, d]) => key !== me && sameGame(d, g)).map(([key]) => key);
    const own = mine();
    return own && sameGame(own, g) ? [...keys, me] : keys;
  }, { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });

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
  // Two started at once: whoever is in the later one moves over to the first.
  createEffect(now, (g) => { const own = untrack(mine); if (own && g && !sameGame(own, g)) declare(g); });
  // Out of the call, out of the game: the Room forgets it with my place in the call.
  createEffect(inCall, (on) => { if (!on && untrack(mine)) { setMine(null); sealing++; } });
  // The links follow who plays: to every other player while I play, to nobody when I do not.
  createEffect(() => ({ g: mine(), m: members() }), ({ g, m }) => { room.gameLinks.play(g ? g.id : null, m); });
  onCleanup(() => room.gameLinks.play(null, []));

  return {
    now,
    members,
    /** Whether I play it. */
    joined: () => { const own = mine(); return own !== null && sameGame(own, now()); },
    /** Starts `name` for the call; one going on already, I join instead, whichever it is. */
    start: (name: GameName): void => {
      if (!inCall()) return;
      const going = untrack(now);
      if (going) { declare(going); return; }
      declare({ game: name, id: toBase64Url(crypto.getRandomValues(new Uint8Array(6))), at: Math.round(room.roomNow() ?? Date.now()) });
    },
    /** Into the game going on. */
    join: (): void => { const g = untrack(now); if (g && inCall()) declare(g); },
    /** Out of it; it goes on for whoever else plays. */
    leave: (): void => { if (untrack(mine)) declare(null); },
    links: room.gameLinks,
    me,
  };
}
export type GameHandle = ReturnType<typeof createGame>;
