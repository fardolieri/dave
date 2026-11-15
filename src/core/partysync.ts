// Keeping a YouTube player in step with a watch party (core/party.ts), both ways: what the party does, the player does,
// and what the friend does in the player changes the party for everyone. Runtime-neutral: the app (client/party.ts)
// hands it what YouTube's player reports (client/ytplayer.ts) and each change of the party, and does what it answers:
// commands for the player, and a change to declare.
import { atOrPast, driftAllowed, fromSeeking, jumped, positionAt, sameChange, seekMore, type Party, type Seeking } from './party';

/** YouTube's player states. */
export const UNSTARTED = -1, ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3, CUED = 5;

/** What the player said last, and when (ms, the app's own clock: `performance.now()`). */
export type PlayerReport = { state: number; time: number; rate: number; duration: number; muted: boolean; at: number };

/** What the app is to ask of the player. */
export type Command =
  | { do: 'play' } | { do: 'pause' } | { do: 'seek'; to: number } | { do: 'rate'; to: number } | { do: 'mute' } | { do: 'unMute' }
  /** Another video, from `seconds`: played, or held there (cued). */
  | { do: 'load'; video: string; seconds: number; playing: boolean };

/** What the friend did in the player, for everyone in the party. */
export type Changed = { playing: boolean; pos: number; rate: number };

/** The clocks a step reads: the app's own (`performance.now()`) and the Room's, as the app knows it (ms). */
export type Clock = { now: number; room: number };

/** What a step answers: commands for the player, in order, and maybe the friend's change, for the party. */
export type Step = { commands: Command[]; changed?: Changed };

/** How long a request to the player may go unanswered before the player is taken to have done otherwise. */
export const ASKED_MS = 4000;
/** How long a seek the app asked for is held after it was asked, answered or not (`settle`). */
export const SEEK_HOLD_MS = 1500;
/** How long a player held paused has to start (`hold`) before it is cued instead. */
export const HOLD_MS = 10_000;
/** How often the app looks at a player that went off by itself (`tick`). */
export const TICK_MS = 1000;

/** Where a player telling `r` is at `now`: further on by the time since, while it plays. */
export const playerTime = (r: PlayerReport, now: number): number => (r.state === PLAYING ? r.time + ((now - r.at) / 1000) * r.rate : r.time);

/**
 * A player opened on `video` (an address with no autoplay), kept in step with the party. What the player reports is told
 * apart by what the app asked of it: a request waits for its answer (the state, the time or the speed asked for), and
 * anything else the player does meanwhile or after is the friend's.
 */
export function createPartySync(video: string) {
  /** The change the player was last put to. */
  let applied: Party | null = null;
  let loaded = video;
  let ready = false;
  /** What the player said last. */
  let last: PlayerReport | null = null;
  /** What the app asked of the player and has not seen it do yet, each with when it asked. */
  let wantPlaying: { on: boolean; at: number } | null = null;
  /** A seek asked of the player: where to, from where it was then, and when. */
  let wantTime: Seeking | null = null;
  let wantRate: { to: number; at: number } | null = null;
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
  /** Where the player was cued, held paused: until it plays it says it is at the start, and is not cued there again. */
  let cuedAt: number | null = null;
  /**
   * The player has not played this video yet (just opened, loaded or cued): the times it tells are not its own yet. Not
   * again once it has: YouTube says it is unstarted for a moment when a seek far off waits for the network, too.
   */
  let starting = true;

  /** The commands of the step under way. */
  let out: Command[] = [];
  const send = (c: Command) => { out.push(c); };
  const step = (changed?: Changed): Step => { const s: Step = changed ? { commands: out, changed } : { commands: out }; out = []; return s; };

  const now = (t: Clock) => (last ? playerTime(last, t.now) : 0);
  const play = (on: boolean, t: Clock) => { wantPlaying = { on, at: t.now }; send({ do: on ? 'play' : 'pause' }); };
  const load = (v: string, seconds: number, playing: boolean) => { reloaded = true; send({ do: 'load', video: v, seconds, playing }); };
  /**
   * A player held paused that never played is played from `to`, muted, and paused as soon as it plays (`report`), then
   * unmuted unless it was muted before: it shows the frame the party is paused at, which a cued one does not. Once per
   * video: one that does not start within `HOLD_MS` (a browser that plays nothing by itself) is cued there instead.
   */
  const hold = (to: number, t: Clock) => {
    held = loaded;
    holding = { at: t.now, muted: holding?.muted ?? last?.muted ?? false, played: false, told: !reloaded };
    send({ do: 'mute' });
    load(loaded, to, true);
  };
  const unhold = () => { if (holding && !holding.muted) send({ do: 'unMute' }); holding = null; };
  /**
   * To `to` seconds. A player that never played starts playing on a seek (YouTube's way): one held paused is held there
   * instead (`hold`), or, should it not start so, cued there, which shows YouTube's thumbnail of the video, not its frame.
   */
  const seek = (to: number, playing: boolean, t: Clock) => {
    const state = last?.state ?? UNSTARTED;
    if (!playing && (state === UNSTARTED || state === CUED)) {
      starting = true;
      if (holding || held !== loaded) hold(to, t);
      else { cuedAt = to; load(loaded, to, false); }
      return;
    }
    wantTime = seekMore(wantTime, to, now(t), t.now);
    send({ do: 'seek', to });
  };
  /** Where the player is, as far as the party goes: a cued one where it was cued. */
  const position = (t: Clock) => (cuedAt !== null && last?.state === CUED ? cuedAt : now(t));
  const rate = (to: number, t: Clock) => { wantRate = { to, at: t.now }; send({ do: 'rate', to }); };
  /**
   * Requests answered, or unanswered for too long, are let go. A seek is held a moment past its answer: YouTube may still
   * report the time from before it once.
   */
  const settle = (r: PlayerReport, t: Clock) => {
    if (wantPlaying && ((r.state === PLAYING && wantPlaying.on) || (r.state === PAUSED && !wantPlaying.on) || t.now - wantPlaying.at > ASKED_MS)) wantPlaying = null;
    // Settled: at the last place it was sent to, a moment after.
    if (wantTime && ((atOrPast(wantTime.to[wantTime.to.length - 1]!, wantTime.at, r.time, t.now, r.rate) && t.now - wantTime.at > SEEK_HOLD_MS) || t.now - wantTime.at > ASKED_MS)) wantTime = null;
    if (wantRate && (r.rate === wantRate.to || t.now - wantRate.at > ASKED_MS)) wantRate = null;
    // Started: it has played or been paused, telling a time of its own.
    if (r.state === PLAYING || r.state === PAUSED) starting = false;
  };
  /** Puts the player where the party is. */
  const apply = (p: Party, t: Clock) => {
    applied = p;
    const at = positionAt(p, t.room);
    // It plays on, unmuted, as the party does: asked to, since the hold's own pause may be on its way still.
    if (p.playing && holding) { unhold(); play(true, t); }
    if (p.video !== loaded) {
      loaded = p.video;
      starting = true;
      if (!p.playing) { hold(at, t); if (p.rate !== 1) rate(p.rate, t); return; }
      wantPlaying = { on: p.playing, at: t.now };
      wantTime = seekMore(null, at, now(t), t.now);
      load(p.video, at, p.playing);
      if (p.rate !== 1) rate(p.rate, t);
      return;
    }
    const r = last;
    if (r && r.rate !== p.rate) rate(p.rate, t);
    // Paused at the start, a player that never played is held there too, rather than left on its thumbnail.
    if (!p.playing && held !== loaded && (!r || r.state === UNSTARTED || r.state === CUED)) { starting = true; hold(at, t); return; }
    if (Math.abs(position(t) - at) > driftAllowed(p)) seek(at, p.playing, t);
    if (p.playing ? r?.state !== PLAYING : r?.state === PLAYING) play(p.playing, t);
  };

  return {
    /** The player answered: put where the party is, if there is one. */
    ready(p: Party | null, t: Clock): Step {
      ready = true;
      if (p) apply(p, t);
      return step();
    },
    /** A change of the party, anyone's. */
    follow(p: Party | null, t: Clock): Step {
      if (ready && p && !sameChange(p, applied)) apply(p, t);
      return step();
    },
    /** The friend's change, as the party took it: the player is taken to be where it is. */
    took(p: Party): void { applied = p; },
    /** Something the player said of its state, time or speed (`timed`: this report told the time). */
    report(r: PlayerReport, timed: boolean, t: Clock): Step {
      const before = last;
      last = r;
      // What was asked before this report; it may be the answer, and is let go after it has been read.
      const asked = { playing: wantPlaying, time: wantTime, rate: wantRate };
      const fresh = starting;
      settle(r, t);
      // Held: paused as soon as it plays, unmuted once it has (not on a pause before: the video it had before may be told
      // paused still). Nothing it does meanwhile is the friend's.
      if (holding) {
        if (!holding.told) { if (r.state === UNSTARTED) holding.told = true; }
        else if (r.state === PLAYING) { holding.played = true; send({ do: 'pause' }); }
        else if (r.state === PAUSED && holding.played) unhold();
        return step();
      }
      if (!ready || !applied || !before) return step();
      // Playing when it was asked to pause (a seek can start it): asked again.
      if (asked.playing && !asked.playing.on && r.state === PLAYING) send({ do: 'pause' });
      // Played or paused by the friend: YouTube's own buttons, a click on the video, a key.
      if (r.state !== before.state && !asked.playing && (r.state === PLAYING || r.state === PAUSED) && (r.state === PLAYING) !== applied.playing) {
        // A cued player tells the start until it has played: where it was cued is where it was.
        return step({ playing: r.state === PLAYING, pos: fresh && cuedAt !== null ? cuedAt : r.time, rate: applied.rate });
      }
      if (r.rate !== before.rate && !asked.rate && r.rate !== applied.rate) return step({ playing: applied.playing, pos: r.time, rate: r.rate });
      // A seek: a jump in the time it tells, not YouTube's own while it loads a video. Reports while it buffers count: a
      // seek's jump comes in one, and buffering alone only falls behind. While the app's own seek is under way, a jump
      // to where it asked, or back to where the player was then (a report from before it), is the app's; one anywhere
      // else is the friend's, who may well seek a moment after the app put the player right.
      if (!timed || fresh || starting) return step();
      if (asked.time && fromSeeking(asked.time, r.time, t.now, r.rate)) return step();
      if (jumped(before.time, r.time, r.at - before.at, before.state === PLAYING, before.rate)) { wantTime = null; return step({ playing: applied.playing, pos: r.time, rate: applied.rate }); }
      return step();
    },
    /**
     * Every `TICK_MS`: a player off by more than a little, a slow one or one held up by YouTube, is put back where the
     * party is; one that never started (its first play refused, or lost) is asked again. A paused one is the friend's
     * doing (`report`).
     */
    tick(t: Clock): Step {
      const r = last;
      if (!ready || !applied || !r) return step();
      settle(r, t);
      if (holding) {
        if (t.now - holding.at < HOLD_MS) return step();
        const played = holding.played;
        unhold();
        if (!applied.playing) {
          // It did not start: cued where the party is instead, its thumbnail shown. Or it did and did not pause.
          // Should it start meanwhile, it is paused again (`report`), not taken for the friend's play.
          if (!played) { wantPlaying = { on: false, at: t.now }; cuedAt = positionAt(applied, t.room); load(loaded, cuedAt, false); return step(); }
          if (r.state === PLAYING) { play(false, t); return step(); }
        }
      }
      if (wantPlaying || wantTime || r.state === ENDED || r.state === BUFFERING) return step();
      const at = positionAt(applied, t.room);
      if (r.duration && at > r.duration - 1) return step(); // the party ran past the end: the player stays there
      if (Math.abs(position(t) - at) > driftAllowed(applied)) seek(at, applied.playing, t);
      if (r.rate !== applied.rate && !wantRate) rate(applied.rate, t); // a speed asked of it before it could take one
      if (applied.playing && (r.state === UNSTARTED || r.state === CUED)) play(true, t);
      return step();
    },
  };
}
export type PartySync = ReturnType<typeof createPartySync>;
