// A room's watch party (core/party.ts): who in its call is in it, what it plays and where, and my part in it. Everyone in
// it declares the party as they last took it; the newest change anyone declares is the party's, and taking it declares
// it again, so the party goes on as it was when the friend who made the last change leaves. One per room, beside its
// call (client/call.ts); `syncPlayer` keeps a YouTube player in step with it.
import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import type { LocalIdentity } from './identity';
import type { FileMeta } from '../core/attachment';
import { MAX_QUEUE, QUEUED_BY_LENGTH, asIs, change, current, enqueue, moveQueued, next, putOn, queuedTitle, sameQueue, sameState, type Party, type Queued } from '../core/party';
import { toBase64Url } from '../core/identity';
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
  }, { equals: (a, b) => sameState(a, b) && a?.card === b?.card });
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
  // Taking a newer change declares it again: should its maker leave, the party goes on as they left it. One from an app
  // before queues (none) carries on the queue I had: its friend played, paused or put a card on, and queued nothing.
  createEffect(now, (p) => {
    const own = untrack(mine);
    if (own && p && !sameState(own, p)) declare(p.queue === undefined && own.queue ? { ...p, queue: own.queue } : p);
  });
  // Out of the call, out of the party: the Room forgets it with my place in the call, and so does the app (client/room.ts).
  createEffect(inCall, (on) => { if (!on && untrack(mine)) { setMine(null); sealing++; } });
  const roomNow = (): number => room.roomNow() ?? Date.now();
  /** The YouTube cards of the chat by file and video, for the titles of the queue's. */
  const cards = createMemo(() => {
    const out = new Map<string, FileMeta>();
    // The first of two, as the party's own card is (`cardOf`).
    for (const l of room.lines()) if (l.kind === 'file' && l.file.youtube && !out.has(`${l.file.hash}:${l.file.youtube.id}`)) out.set(`${l.file.hash}:${l.file.youtube.id}`, l.file);
    return out;
  });
  /** The title of my card of a queued video, where my chat has it. */
  const titleOf = (q: Queued): string | undefined => cards().get(`${q.hash}:${q.video}`)?.youtube?.title;
  /** A change of mine to the party going on, as `to` makes it of the party as it is; only while I am in it. */
  const edit = (to: (p: PartyNow, now: number) => Parameters<typeof change>[3] | null): Party | null => {
    const p = untrack(now);
    if (!p || !untrack(mine)) return null;
    const t = roomNow();
    const made = to(p, t);
    if (!made) return null;
    const next = change(p, me, t, made);
    declare(next);
    return next;
  };
  /** The party as it is, to change only its queue: the title from my card where I have it. */
  const keep = (p: PartyNow, t: number, queue: Queued[]) => ({ ...asIs(p, t, p.card?.youtube?.title ?? p.title), queue });

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
      // The queue goes on with the party: Watch together puts a card on now, ahead of it.
      declare(change(untrack(now), me, roomNow(), { hash: card.hash, video: card.youtube.id, title: card.youtube.title, playing: false, pos: 0, rate: 1, queue: going?.queue }));
    },
    /**
     * Puts this YouTube card of the chat on now, from its start, playing, in place of the video playing; the queue as it
     * is, the speed the party's. Only while I am in the party.
     */
    playNow: (card: FileMeta): void => {
      const video = card.youtube?.id;
      if (!video) return;
      edit((p) => putOn(p, { hash: card.hash, video, title: card.youtube?.title }, true));
    },
    /** Into the party going on, where it is. */
    join: (): void => { const p = untrack(now); if (p && inCall()) declare(p); },
    /** Out of it; it goes on for whoever else is in it. */
    leave: (): void => { if (untrack(mine)) declare(null); },
    /** A change I made in my player: played, paused, sought or a new speed, for everyone in it. */
    set: (to: { playing: boolean; pos: number; rate: number }): Party | null => {
      // The title from my card where I have it: a change from an app before titles carries none.
      return edit((p) => ({ hash: p.hash, video: p.video, title: p.card?.youtube?.title ?? p.title, ...to, queue: p.queue }));
    },
    /** What plays next, in order; nothing while there is no party. */
    queue: (): Queued[] => now()?.queue ?? [],
    /** Whether the queue holds as many as it can. */
    full: (): boolean => (now()?.queue?.length ?? 0) >= MAX_QUEUE,
    /** Puts a YouTube card of the chat last in the queue, while I am in the party; false when it could not. */
    enqueue: (card: FileMeta): boolean => {
      const video = card.youtube?.id;
      if (!video) return false;
      const id = toBase64Url(crypto.getRandomValues(new Uint8Array(6)));
      const title = queuedTitle(card.youtube?.title);
      const q: Queued = { id, by: me.slice(0, QUEUED_BY_LENGTH), hash: card.hash, video, ...(title ? { title } : {}) };
      return edit((p, t) => { const queue = enqueue(p.queue ?? [], q); return queue && keep(p, t, queue); }) !== null;
    },
    /** Takes an entry out of the queue. */
    unqueue: (id: string): void => { edit((p, t) => (p.queue?.some((q) => q.id === id) ? keep(p, t, p.queue.filter((q) => q.id !== id)) : null)); },
    /** Moves an entry of the queue up (-1) or down (1). */
    move: (id: string, by: number): void => { edit((p, t) => { const queue = p.queue ?? []; const moved = moveQueued(queue, id, by); return moved === queue ? null : keep(p, t, moved); }); },
    /** The queue's next, now: playing or paused, as the party is. */
    skip: (): void => { edit((p) => next(p, p.playing, (q) => untrack(() => titleOf(q)))); },
    /**
     * My player played `ended` to its end: the queue's next goes on, playing. Not when the party has gone on since to
     * another video or queue (someone else's player ended first): a seek or a speed since is the same video still.
     */
    advance: (ended: Party): boolean =>
      edit((p) => (p.hash === ended.hash && p.video === ended.video && sameQueue(p.queue, ended.queue) ? next(p, true, (q) => untrack(() => titleOf(q))) : null)) !== null,
    /** A queued video's title as my card has it, else as the queue carries it. */
    titleOf: (q: Queued): string | undefined => titleOf(q) ?? q.title,
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
  const clock = () => ({ now: performance.now(), room: party.roomNow(), hidden: document.visibilityState === 'hidden' });
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
    // Played to the end, with more queued: the next goes on, and puts the player there. Not the friend's seek too, which
    // may have taken it to its end: one change, not two at once.
    if (s.ended && party.advance(s.ended)) return;
    if (s.changed) { const next = party.set(s.changed); if (next) sync.took(next); }
  };
  const player: Player = connectPlayer(frame, video, {
    ready: () => run(sync.ready(untrack(party.now), clock())),
    report: (_before, now, timed, stated) => run(sync.report(now, timed, clock(), stated)),
    error: (code) => { run(sync.error(code)); onError(code); },
  });
  const tick = setInterval(() => run(sync.tick(clock())), TICK_MS);
  // A step as the page hides or shows: hidden before the browser pauses the player (and may stop the page's timers).
  const seen = () => run(sync.tick(clock()));
  document.addEventListener('visibilitychange', seen);
  return {
    follow: (p) => run(sync.follow(p, clock())),
    dispose: () => { clearInterval(tick); document.removeEventListener('visibilitychange', seen); player.dispose(); },
  };
}
