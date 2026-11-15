// A room's watch party (core/party.ts): who in its call is in it, what it plays and where, and my part in it. Everyone in
// it declares the party as they last took it; the newest change anyone declares is the party's, and taking it declares
// it again, so the party goes on as it was when the friend who made the last change leaves. One per room, beside its
// call (client/call.ts); `syncPlayer` keeps a YouTube player in step with it.
import { createEffect, createMemo, createSignal, untrack } from 'solid-js';
import type { LocalIdentity } from './identity';
import type { FileMeta } from '../core/attachment';
import { atOrPast, change, driftAllowed, fromSeeking, seekMore, type Seeking, current, jumped, positionAt, sameChange, type Party } from '../core/party';
import { openParty, sealParty } from '../core/sealed';
import type { ChatLine, createRoom } from './room';
import { BUFFERING, CUED, ENDED, PAUSED, PLAYING, UNSTARTED, connectPlayer, type Player, type PlayerReport } from './ytplayer';

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
     * is there; one going on puts it on instead, paused at its start, for everyone in it.
     */
    start: (card: FileMeta): void => {
      if (!card.youtube || !inCall()) return;
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

/** How long a request to the player may go unanswered before the player is taken to have done otherwise. */
const ASKED_MS = 4000;
/** How long a seek the app asked for is held after it was asked, answered or not (`settle`). */
const SEEK_HOLD_MS = 1500;
/** How long a player held paused has to start (`hold`) before it is cued instead. */
const HOLD_MS = 10_000;

/**
 * Keeps the YouTube player in `frame`, whose address plays `video`, in step with the party, both ways: what the party
 * does, the player does (`follow`, with each change; where it drifts off, it is put back), and what the friend does in
 * the player (play, pause, a seek, a new speed) changes the party for everyone. `onError` gets YouTube's code, should it
 * refuse to play. What the player reports is told apart by what the app asked of it: a request waits for its answer (the
 * state, the time or the speed asked for), and anything else the player does meanwhile or after is the friend's.
 */
export function syncPlayer(frame: HTMLIFrameElement, video: string, party: PartyHandle, onError: (code: number) => void): { follow: (p: Party | null) => void; dispose: () => void } {
  /** The change the player was last put to. */
  let applied: Party | null = null;
  let loaded = video;
  let ready = false;
  /** What the app asked of the player and has not seen it do yet, each with when it asked. */
  let wantPlaying: { on: boolean; at: number } | null = null;
  /** A seek asked of the player: where to, from where it was then, and when. */
  let wantTime: Seeking | null = null;
  let wantRate: { to: number; at: number } | null = null;
  const play = (on: boolean) => { wantPlaying = { on, at: performance.now() }; if (on) player.play(); else player.pause(); };
  /**
   * To `to` seconds. A player that never played starts playing on a seek (YouTube's way): one held paused is held there
   * instead (`hold`), or, should it not start so, cued there, which shows YouTube's thumbnail of the video, not its frame.
   */
  const seek = (to: number, playing: boolean) => {
    const state = player.report()?.state ?? UNSTARTED;
    if (!playing && (state === UNSTARTED || state === CUED)) {
      starting = true;
      if (holding || held !== loaded) hold(to);
      else { cuedAt = to; load(loaded, to, false); }
      return;
    }
    wantTime = seekMore(wantTime, to, player.now(), performance.now());
    player.seek(to);
  };
  /**
   * A player held paused that never played is played from `to`, muted, and paused as soon as it plays (`report`), then
   * unmuted unless it was muted before: it shows the frame the party is paused at, which a cued one does not. Once per
   * video: one that does not start within `HOLD_MS` (a browser that plays nothing by itself) is cued there instead.
   */
  const hold = (to: number) => {
    held = loaded;
    holding = { at: performance.now(), muted: holding?.muted ?? player.report()?.muted ?? false, played: false, told: !reloaded };
    player.mute();
    load(loaded, to, true);
  };
  /**
   * Held, until it has paused after playing: since when, whether it was muted before, whether it has played, and whether
   * it has told of the video it was given yet. A player given a video before tells of that one for a moment (seen
   * 2026-11-15, over one playing: buffering, paused at 0 s, then unstarted, as it loads the new one; and what it was on
   * its way to), and a report of its time alone keeps the state it told before: only from its first `UNSTARTED` on is
   * what it tells of the held video. A new player's first hold has nothing before it.
   */
  let holding: { at: number; muted: boolean; played: boolean; told: boolean } | null = null;
  /** The video last held. */
  let held: string | null = null;
  /** Whether the player was given a video since it opened. */
  let reloaded = false;
  const load = (video: string, seconds: number, playing: boolean) => { reloaded = true; player.load(video, seconds, playing); };
  const unhold = () => { if (holding && !holding.muted) player.unMute(); holding = null; };
  /** Where the player was cued, held paused: until it plays it says it is at the start, and is not cued there again. */
  let cuedAt: number | null = null;
  /**
   * The player has not played this video yet (just opened, loaded or cued): the times it tells are not its own yet. Not
   * again once it has: YouTube says it is unstarted for a moment when a seek far off waits for the network, too.
   */
  let starting = true;
  /** Where the player is, as far as the party goes: a cued one where it was cued. */
  const position = () => (cuedAt !== null && player.report()?.state === CUED ? cuedAt : player.now());
  const rate = (to: number) => { wantRate = { to, at: performance.now() }; player.rate(to); };
  /**
   * Requests answered, or unanswered for too long, are let go. A seek is held a moment past its answer: YouTube may still
   * report the time from before it once.
   */
  const settle = (r: PlayerReport) => {
    const now = performance.now();
    if (wantPlaying && ((r.state === PLAYING && wantPlaying.on) || (r.state === PAUSED && !wantPlaying.on) || now - wantPlaying.at > ASKED_MS)) wantPlaying = null;
    // Settled: at the last place it was sent to, a moment after.
    if (wantTime && ((atOrPast(wantTime.to[wantTime.to.length - 1]!, wantTime.at, r.time, now, r.rate) && now - wantTime.at > SEEK_HOLD_MS) || now - wantTime.at > ASKED_MS)) wantTime = null;
    if (wantRate && (r.rate === wantRate.to || now - wantRate.at > ASKED_MS)) wantRate = null;
    // Started: it has played or been paused, telling a time of its own.
    if (r.state === PLAYING || r.state === PAUSED) starting = false;
  };
  /** Puts the player where the party is. */
  const apply = (p: Party) => {
    applied = p;
    const at = positionAt(p, party.roomNow());
    // It plays on, unmuted, as the party does: asked to, since the hold's own pause may be on its way still.
    if (p.playing && holding) { unhold(); play(true); }
    if (p.video !== loaded) {
      loaded = p.video;
      starting = true;
      if (!p.playing) { hold(at); if (p.rate !== 1) rate(p.rate); return; }
      wantPlaying = { on: p.playing, at: performance.now() };
      wantTime = seekMore(null, at, player.now(), performance.now());
      load(p.video, at, p.playing);
      if (p.rate !== 1) rate(p.rate);
      return;
    }
    const r = player.report();
    if (r && r.rate !== p.rate) rate(p.rate);
    // Paused at the start, a player that never played is held there too, rather than left on its thumbnail.
    if (!p.playing && held !== loaded && (!r || r.state === UNSTARTED || r.state === CUED)) { starting = true; hold(at); return; }
    if (Math.abs(position() - at) > driftAllowed(p)) seek(at, p.playing);
    if (p.playing ? r?.state !== PLAYING : r?.state === PLAYING) play(p.playing);
  };
  /** The friend changed something in the player: the party follows, and the player is taken to be where it is. */
  const changed = (to: { playing: boolean; pos: number; rate: number }) => { const next = party.set(to); if (next) applied = next; };
  const player: Player = connectPlayer(frame, video, {
    ready: () => {
      ready = true;
      const p = untrack(party.now);
      if (p) apply(p);
    },
    report: (before, now, timed) => {
      // What was asked before this report; it may be the answer, and is let go after it has been read.
      const asked = { playing: wantPlaying, time: wantTime, rate: wantRate };
      const fresh = starting;
      settle(now);
      // Held: paused as soon as it plays, unmuted once it has (not on a pause before: the video it had before may be told
      // paused still). Nothing it does meanwhile is the friend's.
      if (holding) {
        if (!holding.told) { if (now.state === UNSTARTED) holding.told = true; }
        else if (now.state === PLAYING) { holding.played = true; player.pause(); }
        else if (now.state === PAUSED && holding.played) unhold();
        return;
      }
      if (!ready || !applied || !before) return;
      // Playing when it was asked to pause (a seek can start it): asked again.
      if (asked.playing && !asked.playing.on && now.state === PLAYING) player.pause();
      // Played or paused by the friend: YouTube's own buttons, a click on the video, a key.
      if (now.state !== before.state && !asked.playing && (now.state === PLAYING || now.state === PAUSED) && (now.state === PLAYING) !== applied.playing) {
        // A cued player tells the start until it has played: where it was cued is where it was.
        changed({ playing: now.state === PLAYING, pos: fresh && cuedAt !== null ? cuedAt : now.time, rate: applied.rate });
        return;
      }
      if (now.rate !== before.rate && !asked.rate && now.rate !== applied.rate) { changed({ playing: applied.playing, pos: now.time, rate: now.rate }); return; }
      // A seek: a jump in the time it tells, not YouTube's own while it loads a video. Reports while it buffers count: a
      // seek's jump comes in one, and buffering alone only falls behind. While the app's own seek is under way, a jump
      // to where it asked, or back to where the player was then (a report from before it), is the app's; one anywhere
      // else is the friend's, who may well seek a moment after the app put the player right.
      if (!timed || fresh || starting) return;
      if (asked.time && fromSeeking(asked.time, now.time, performance.now(), now.rate)) return;
      if (jumped(before.time, now.time, now.at - before.at, before.state === PLAYING, before.rate)) { wantTime = null; changed({ playing: applied.playing, pos: now.time, rate: applied.rate }); }
    },
    error: onError,
  });
  // A player off by more than a little, a slow one or one held up by YouTube, is put back where the party is; one that
  // never started (its first play refused, or lost) is asked again. A paused one is the friend's doing (above).
  const drift = setInterval(() => {
    const r = player.report();
    if (!ready || !applied || !r) return;
    settle(r);
    if (holding) {
      if (performance.now() - holding.at < HOLD_MS) return;
      const played = holding.played;
      unhold();
      if (!applied.playing) {
        // It did not start: cued where the party is instead, its thumbnail shown. Or it did and did not pause.
        // Should it start meanwhile, it is paused again (`report`), not taken for the friend's play.
        if (!played) { wantPlaying = { on: false, at: performance.now() }; cuedAt = positionAt(applied, party.roomNow()); load(loaded, cuedAt, false); return; }
        if (r.state === PLAYING) { play(false); return; }
      }
    }
    if (wantPlaying || wantTime || r.state === ENDED || r.state === BUFFERING) return;
    const at = positionAt(applied, party.roomNow());
    if (r.duration && at > r.duration - 1) return; // the party ran past the end: the player stays there
    if (Math.abs(position() - at) > driftAllowed(applied)) seek(at, applied.playing);
    if (r.rate !== applied.rate && !wantRate) rate(applied.rate); // a speed asked of it before it could take one
    if (applied.playing && (r.state === UNSTARTED || r.state === CUED)) play(true);
  }, 1000);
  return {
    follow: (p) => { if (ready && p && !sameChange(p, applied)) apply(p); },
    dispose: () => { clearInterval(drift); player.dispose(); },
  };
}
