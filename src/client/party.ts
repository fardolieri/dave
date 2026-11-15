// A room's watch party (core/party.ts): who in its call is in it, what it plays and where, and my part in it. Everyone in
// it declares the party as they last took it; the newest change anyone declares is the party's, and taking it declares
// it again, so the party goes on as it was when the friend who made the last change leaves. One per room, beside its
// call (client/call.ts); `syncPlayer` keeps a YouTube player in step with it.
import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import type { LocalIdentity } from './identity';
import type { FileMeta } from '../core/attachment';
import { change, current, sameChange, type Party } from '../core/party';
import { TICK_MS, createPartySync, type Step } from '../core/partysync';
import { openParty, sealParty } from '../core/sealed';
import type { ChatLine, createRoom } from './room';
import { connectPlayer, type Player } from './ytplayer';

type Room = ReturnType<typeof createRoom>;
/** A party with the card it plays, as the chat has it: none for a friend new to the room since it was sent (ADR 0009). */
export type PartyNow = Party & { card: FileMeta | null };

/** The YouTube card of the chat whose file is `hash`, with the video `video`; null for none. */
function cardOf(lines: readonly ChatLine[], hash: string, video: string): FileMeta | null {
  for (const l of lines) if (l.kind === 'file' && l.file.hash === hash && l.file.youtube?.id === video) return l.file;
  return null;
}

export function createParty(room: Room, identity: LocalIdentity, textKey: CryptoKey, inCall: () => boolean) {
  const me = identity.publicKey;
  /** Each friend's party as opened, by the sealed text it came as: the same text is opened once. */
  const opened = new Map<string, Promise<Party | null>>();
  const [parties, setParties] = createSignal<ReadonlyMap<string, Party>>(new Map());
  // Every participant's party opened, in the order presence lists them; one that does not open counts as none.
  createEffect(() => room.people().filter((p) => p.role === 'participant' && p.party).map((p) => [p.publicKey, p.party!] as const), (entries) => {
    let stale = false;
    void Promise.all(entries.map(async ([key, sealed]) => {
      const id = `${key}:${sealed}`;
      let p = opened.get(id);
      if (!p) { p = openParty({ key: textKey, roomId: room.roomId, from: key, sealed }); opened.set(id, p); }
      return [key, await p] as const;
    })).then((all) => {
      if (stale) return;
      const next = new Map<string, Party>();
      for (const [key, p] of all) if (p) next.set(key, p);
      setParties(next);
      for (const id of opened.keys()) if (!entries.some(([key, sealed]) => id === `${key}:${sealed}`)) opened.delete(id);
    });
    return () => { stale = true; };
  });
  /** What I declared last: what I am in, as I took it; null for none. */
  const [mine, setMine] = createSignal<Party | null>(null);
  /**
   * The party: the newest change declared by anyone in it, mine included before the Room brings it back, with its card
   * when this chat has it. Null when nobody in the call is in one. A friend's app follows one whose card it does not
   * have: it came to the room after the card, and does not see what was said before (ADR 0009).
   */
  const now = createMemo((): PartyNow | null => {
    const lines = room.lines();
    const all = [...parties().entries()].filter(([key]) => key !== me).map(([, p]) => p);
    const own = mine();
    const newest = current(own ? [...all, own] : all);
    return newest && { ...newest, card: cardOf(lines, newest.hash, newest.video) };
  }, { equals: (a, b) => sameChange(a, b) && a?.card === b?.card });
  /** Who is in it: friends in the call who declare one, and me while I am in it. */
  const members = createMemo((): string[] => {
    const keys = [...parties().keys()].filter((k) => k !== me);
    return mine() ? [...keys, me] : keys;
  }, { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });

  let sealing = 0;
  /** Declares `p` as the party I am in (null: none), sealed; only the latest of several sealed at once goes. */
  const declare = (p: Party | null): void => {
    setMine(p);
    const n = ++sealing;
    if (!p) { room.declare({ t: 'party' }); return; }
    void sealParty({ key: textKey, privateKey: identity.keys.privateKey, roomId: room.roomId, from: me, party: p }).then(
      (sealed) => { if (n === sealing) room.declare({ t: 'party', sealed }); },
      (e: unknown) => console.error('sealing the watch party failed', e),
    );
  };
  // Taking a newer change declares it again: should its maker leave, the party goes on as they left it.
  createEffect(now, (p) => { const own = untrack(mine); if (own && p && !sameChange(own, p)) declare(p); });
  // Out of the call, out of the party: the Room forgets it with my place in the call, and so does the app (client/room.ts).
  createEffect(inCall, (on) => { if (!on && untrack(mine)) { setMine(null); sealing++; } });
  const roomNow = (): number => room.roomNow() ?? Date.now();

  return {
    now,
    members,
    /** Whether I am in it. */
    joined: () => mine() !== null,
    /**
     * Starts a party with this YouTube card of the chat, paused at its start, for whoever is in it to play when everyone
     * is there; one going on puts it on instead, paused at its start, for everyone in it. One playing this card already
     * goes on where it is: I join it, if I am not in it.
     */
    start: (card: FileMeta): void => {
      if (!card.youtube || !inCall()) return;
      const going = untrack(now);
      if (going && going.hash === card.hash && going.video === card.youtube.id) { if (!untrack(mine)) declare(going); return; }
      declare(change(untrack(now), me, roomNow(), { hash: card.hash, video: card.youtube.id, title: card.youtube.title, playing: false, pos: 0, rate: 1 }));
    },
    /** Into the party going on, where it is. */
    join: (): void => { const p = untrack(now); if (p && inCall()) declare(p); },
    /** Out of it; it goes on for whoever else is in it. */
    leave: (): void => { if (untrack(mine)) declare(null); },
    /** A change I made in my player: played, paused, sought or a new speed, for everyone in it. */
    set: (to: { playing: boolean; pos: number; rate: number }): Party | null => {
      const p = untrack(now);
      if (!p || !untrack(mine)) return null;
      // The title from my card where I have it: a change from an app before titles carries none.
      const next = change(p, me, roomNow(), { hash: p.hash, video: p.video, title: p.card?.youtube?.title ?? p.title, ...to });
      declare(next);
      return next;
    },
    roomNow,
  };
}
export type PartyHandle = ReturnType<typeof createParty>;

/**
 * Keeps the YouTube player in `frame`, whose address plays `video`, in step with the party, both ways (core/partysync.ts):
 * what the party does, the player does, and what the friend does in the player (play, pause, a seek, a new speed)
 * changes the party for everyone. `onError` gets YouTube's code, should it refuse to play.
 */
export function syncPlayer(frame: HTMLIFrameElement, video: string, party: PartyHandle, onError: (code: number) => void): { follow: (p: Party | null) => void; dispose: () => void } {
  const sync = createPartySync(video);
  const clock = () => ({ now: performance.now(), room: party.roomNow() });
  const run = (s: Step) => {
    for (const c of s.commands) {
      if (c.do === 'play') player.play();
      else if (c.do === 'pause') player.pause();
      else if (c.do === 'seek') player.seek(c.to);
      else if (c.do === 'rate') player.rate(c.to);
      else if (c.do === 'mute') player.mute();
      else if (c.do === 'unMute') player.unMute();
      else player.load(c.video, c.seconds, c.playing);
    }
    if (s.changed) { const next = party.set(s.changed); if (next) sync.took(next); }
  };
  const player: Player = connectPlayer(frame, video, {
    ready: () => run(sync.ready(untrack(party.now), clock())),
    report: (_before, now, timed, stated) => run(sync.report(now, timed, clock(), stated)),
    error: (code) => { run(sync.error(code)); onError(code); },
  });
  const tick = setInterval(() => run(sync.tick(clock())), TICK_MS);
  return {
    follow: (p) => run(sync.follow(p, clock())),
    dispose: () => { clearInterval(tick); player.dispose(); },
  };
}
