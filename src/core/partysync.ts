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

/**
 * The clocks a step reads, the app's own (`performance.now()`) and the Room's as the app knows it (ms), and whether the
 * page is hidden: a phone pauses the player of a page it hides (another app, a locked screen, a link of YouTube's that
 * opens a tab), which is not the friend's pause.
 */
export type Clock = { now: number; room: number; hidden?: boolean };

/** What a step answers: commands for the player, in order, and maybe the friend's change, for the party. */
export type Step = { commands: Command[]; changed?: Changed };

/** How long a seek asked of the player may go unanswered before the player is taken to have done otherwise. */
export const ASKED_MS = 4000;
/** How long a play or pause asked of the player waits before it is asked again, should the player not do it. */
export const RESEND_MS = 1000;
/** How many times a speed is asked again of a player that does not take it. */
export const RATE_TRIES = 3;
/** How long after a page is shown again what its player does is not the friend's: it settles, and is put right. */
export const SHOWN_QUIET_MS = 2000;
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
 * apart by what the app asked of it: until the player has done what the app asked (played, paused, gone to a time, taken
 * a speed), what it does about that is not the friend's, and a player doing otherwise is asked again; once it has, what
 * it does is the friend's. A seek is told by where it went (`fromSeeking`), so a friend's seek counts even while the
 * app's is under way.
 */
export function createPartySync(video: string) {
  /** The change the player was last put to. */
  let applied: Party | null = null;
  let loaded = video;
  let ready = false;
  /** What the player said last. */
  let last: PlayerReport | null = null;
  /**
   * A play or pause asked of the player and not done yet: when it was last sent, for one that may well never be done (a
   * cued player's) until when it is waited for, and whether the player has said it is otherwise since it was asked (one
   * asked to play while it still says it plays, a pause on its way, has not). Not given up otherwise: a pause can always
   * be done, and a play the browser refuses waits for the friend's own press of play.
   */
  let want: { on: boolean; sent: number; until?: number; left: boolean } | null = null;
  /** A seek asked of the player: where to, from where it was then, and when. */
  let wantTime: Seeking | null = null;
  /** A speed asked of the player and not taken yet: when it was last sent, and how often. */
  let wantRate: { to: number; sent: number; tries: number } | null = null;
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
  /** The video YouTube refused to play here (an error): nothing more is asked of the player until another one. */
  let refused: string | null = null;
  /** The player was given a video after one YouTube refused: it played nothing it could still tell of. */
  let afterRefused = false;
  /** An unmute sent, not yet told back by the player: what it says of its sound until then is the app's own mute. */
  let unmuteOwed = false;
  /**
   * Whether the page was hidden at the last step, until when what the player does is not the friend's, and a speed owed
   * since the page was shown again. A hidden page's player is the browser's (a phone pauses it, and unloads its video),
   * and once shown it settles for a moment: the answer to a seek asked while hidden comes only then (seen with phone
   * profiles, 2026-11-15). Meanwhile the tick puts it where the party is. A phone loads the video again at 1x while the
   * player still says the speed it had, and takes that speed asked again only after another: asked once it plays.
   */
  let hidden = false;
  let quietUntil = 0;
  let rateOwed = false;
  const see = (t: Clock) => {
    if (hidden && !t.hidden) { quietUntil = t.now + SHOWN_QUIET_MS; rateOwed = true; }
    hidden = !!t.hidden;
  };
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
  /** Asks the player to play, or to pause; until `until`, if it may never. */
  const ask = (on: boolean, t: Clock, until?: number) => {
    const left = !done(on, last?.state ?? UNSTARTED);
    want = until === undefined ? { on, sent: t.now, left } : { on, sent: t.now, until, left };
    send({ do: on ? 'play' : 'pause' });
  };
  /** Whether a player in `state` has done what was asked: played (or played to the end), or paused (or been cued). */
  const done = (on: boolean, state: number) => (on ? state === PLAYING || state === ENDED : state === PAUSED || state === CUED);
  /**
   * Whether a player in `state` does otherwise than the party: not playing while it plays; playing, or about to (a
   * player that buffers, or that has played and waits for the network), while it is paused. One that never played is
   * held (`hold`), and one that ended stays so (`atEnd`).
   */
  const otherwise = (on: boolean, state: number) => (on ? state !== PLAYING : state === PLAYING || state === BUFFERING || (state === UNSTARTED && !starting));
  /** Plays, or pauses, as the party does: a request the other way under way is turned around at once. A held player pauses by itself. */
  const playAsParty = (on: boolean, t: Clock) => {
    if (holding) return;
    if (want) { if (want.on !== on) ask(on, t); return; }
    if (otherwise(on, last?.state ?? UNSTARTED)) ask(on, t);
  };
  /**
   * Whether the party, playing, is at its video's end as far as this player goes: past it (within a second: YouTube's
   * first word on a video's length is a little long), or where this player ended. There the player stays ended: a seek
   * or a play would start it again from its start.
   */
  const atEnd = (p: Party, r: PlayerReport, t: Clock) => {
    const at = positionAt(p, t.room);
    return p.playing && r.duration > 0 && (at > r.duration - 1 || (r.state === ENDED && at > r.time - driftAllowed(p)));
  };
  /** A player at the end of a party past it stays there; one not near it (just come in) plays to it from a little before. */
  const toEnd = (r: PlayerReport, t: Clock) => {
    if (r.state === ENDED) return;
    if (now(t) < r.duration - 3) seek(Math.max(0, r.duration - 2), true, t);
    playAsParty(true, t);
  };
  const load = (v: string, seconds: number, playing: boolean) => { reloaded = true; send({ do: 'load', video: v, seconds, playing }); };
  /**
   * A player held paused that never played is played from `to`, muted, and paused as soon as it plays (`report`), then
   * unmuted unless it was muted before: it shows the frame the party is paused at, which a cued one does not. Once per
   * video: one that does not start within `HOLD_MS` (a browser that plays nothing by itself) is cued there instead.
   */
  const hold = (to: number, t: Clock) => {
    held = loaded;
    want = null; // it pauses by itself
    // Told of this video from the start: a new player that has not played yet. One that has (joined while the party
    // played) may tell of what it played for a moment, as one given a video before does.
    const fresh = afterRefused || (!reloaded && (!last || last.state === UNSTARTED || last.state === CUED));
    afterRefused = false;
    // Muted before: the friend's own choice, kept; not the app's own mute of a hold before, unmuted since.
    holding = { at: t.now, muted: holding?.muted ?? (unmuteOwed ? false : last?.muted ?? false), played: false, told: fresh };
    send({ do: 'mute' });
    load(loaded, to, true);
  };
  const unhold = () => { if (holding && !holding.muted) { send({ do: 'unMute' }); unmuteOwed = true; } holding = null; };
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
    // An ended player plays on a seek (YouTube's way): paused again, as the party is.
    if (!playing && state === ENDED) ask(false, t);
  };
  /** Where the player is, as far as the party goes: a cued one where it was cued. */
  const position = (t: Clock) => (cuedAt !== null && last?.state === CUED ? cuedAt : now(t));
  const rate = (to: number, t: Clock) => { wantRate = { to, sent: t.now, tries: 1 }; send({ do: 'rate', to }); };
  /**
   * Requests done are let go. A play or pause only on a report that says the player's state (`stated`; one of the time
   * alone carries the state told before), once the player has said it is otherwise since it was asked, or a while after:
   * a request turned around comes while the player still says what it is to be. A seek is held a moment past its answer
   * (YouTube may still report the time from before it once), and let go unanswered after a while: the drift check sends
   * it again, and a friend's seek counts meanwhile.
   */
  const settle = (r: PlayerReport, t: Clock, stated: boolean) => {
    if (want && stated) {
      if (!done(want.on, r.state)) want.left = true;
      else if (want.left || t.now - want.sent > RESEND_MS) want = null;
    }
    if (want?.until !== undefined && t.now > want.until) want = null;
    // Settled: at the last place it was sent to, a moment after.
    if (wantTime && ((atOrPast(wantTime.to[wantTime.to.length - 1]!, wantTime.at, r.time, t.now, r.rate) && t.now - wantTime.at > SEEK_HOLD_MS) || t.now - wantTime.at > ASKED_MS)) wantTime = null;
    if (wantRate && r.rate === wantRate.to) wantRate = null;
    // Started: it has played or been paused, telling a time of its own.
    if (r.state === PLAYING || r.state === PAUSED) starting = false;
  };
  /** Puts the player where the party is. */
  const apply = (p: Party, t: Clock) => {
    applied = p;
    const at = positionAt(p, t.room);
    // It plays on, unmuted, as the party does: asked to, since the hold's own pause may be on its way still. Paused again
    // before it has played, it is held again.
    if (p.playing && holding) { unhold(); held = null; ask(true, t); }
    if (p.video !== loaded) {
      afterRefused = refused === loaded;
      loaded = p.video;
      refused = null;
      starting = true;
      if (!p.playing) { hold(at, t); if (p.rate !== 1) rate(p.rate, t); return; }
      want = { on: true, sent: t.now, left: false };
      wantTime = seekMore(null, at, now(t), t.now);
      load(p.video, at, p.playing);
      if (p.rate !== 1) rate(p.rate, t);
      return;
    }
    if (refused === loaded) return;
    const r = last;
    if (r && r.rate !== p.rate && wantRate?.to !== p.rate) rate(p.rate, t);
    // Paused at the start, a player that never played is held there too, rather than left on its thumbnail.
    if (!p.playing && held !== loaded && (!r || r.state === UNSTARTED || r.state === CUED || (starting && r.state === BUFFERING))) { starting = true; hold(at, t); return; }
    if (r && atEnd(p, r, t)) { toEnd(r, t); return; }
    if (Math.abs(position(t) - at) > driftAllowed(p)) seek(at, p.playing, t);
    playAsParty(p.playing, t);
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
      see(t);
      if (ready && p && !sameChange(p, applied)) apply(p, t);
      return step();
    },
    /** YouTube refused to play the video here (`onError`): a hold under way is ended, unmuted as it owes. */
    error(_code: number): Step {
      unhold();
      refused = loaded; want = null; wantTime = null; wantRate = null;
      return step();
    },
    /** The friend's change, as the party took it: the player is taken to be where it is. */
    took(p: Party): void { applied = p; },
    /** Something the player said of its state, time or speed (`timed`: this report told the time). */
    report(r: PlayerReport, timed: boolean, t: Clock, stated = true): Step {
      see(t);
      const before = last;
      last = r;
      if (!r.muted) unmuteOwed = false;
      // What was asked before this report; it may be the answer, and is let go after it has been read.
      const asked = { time: wantTime, rate: wantRate };
      const fresh = starting;
      settle(r, t, stated);
      // Held: paused as soon as it plays, unmuted once it has (not on a pause before: the video it had before may be told
      // paused still). Nothing it does meanwhile is the friend's.
      if (holding) {
        if (!holding.told) { if (r.state === UNSTARTED) holding.told = true; }
        else if (r.state === PLAYING) { holding.played = true; send({ do: 'pause' }); }
        else if (r.state === PAUSED && holding.played) unhold();
        return step();
      }
      if (!ready || !applied || !before) return step();
      // Judged before the speed is asked again below: the report that sets it off may be the friend's own play.
      const quiet = t.hidden || t.now < quietUntil;
      if (rateOwed && stated && r.state === PLAYING && !t.hidden) {
        rateOwed = false;
        // 1x first, then the party's speed; what the player says of them a moment after is the app's.
        if (applied.rate !== 1) { send({ do: 'rate', to: 1 }); rate(applied.rate, t); quietUntil = Math.max(quietUntil, t.now + RESEND_MS); }
      }
      if (want) {
        // Not done yet: what it does meanwhile is not the friend's. Playing when it was asked to pause (a seek, or the
        // buffering of one, can start it): asked again, at once. Paused when it was asked to play: asked again after a
        // while, as a report from before the play may still say it is paused.
        // Hidden, a player is asked to pause still (a desktop browser plays a hidden tab on), not to play (a phone's
        // browser holds it paused; it is asked once shown).
        if (stated && !want.on && r.state === PLAYING) ask(false, t);
        else if (stated && want.on && r.state === PAUSED && t.now - want.sent > RESEND_MS && !t.hidden) ask(true, t);
      } else if (!quiet && r.state !== before.state && (r.state === PLAYING || r.state === PAUSED) && (r.state === PLAYING) !== applied.playing) {
        // Played or paused by the friend: YouTube's own buttons, a click on the video, a key.
        // A cued player tells the start until it has played: where it was cued is where it was.
        return step({ playing: r.state === PLAYING, pos: fresh && cuedAt !== null ? cuedAt : r.time, rate: applied.rate });
      }
      if (quiet) return step();
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
     * Every `TICK_MS`: a request not done is asked again; a player off by more than a little, a slow one or one held up by
     * YouTube, is put back where the party is, playing or paused as it is.
     */
    tick(t: Clock): Step {
      see(t);
      const r = last;
      if (!ready || !applied || !r || refused === loaded) return step();
      settle(r, t, false);
      // Nothing asked of a player a hidden page's browser holds paused; one that plays on (a desktop's) is kept in step.
      if (t.hidden && !holding && r.state !== PLAYING) return step();
      // Asked a while ago, and the player says it is so: done, though it said nothing since (a pause asked of a player
      // paused already, whose play the browser refused, tells nothing new).
      if (want && t.now - want.sent > RESEND_MS && done(want.on, r.state)) want = null;
      if (holding) {
        if (t.now - holding.at < HOLD_MS) return step();
        const played = holding.played;
        unhold();
        if (!applied.playing) {
          // It did not start: cued where the party is instead, its thumbnail shown. Or it did and did not pause.
          // Should it start meanwhile, it is paused again (`report`), not taken for the friend's play.
          if (!played) { want = { on: false, sent: t.now, until: t.now + ASKED_MS, left: true }; cuedAt = positionAt(applied, t.room); load(loaded, cuedAt, false); return step(); }
          if (r.state === PLAYING) { ask(false, t); return step(); }
        }
      }
      // A speed asked before the player could take one, or lost: again, a few times.
      if (wantRate && t.now - wantRate.sent > RESEND_MS) {
        if (wantRate.tries >= RATE_TRIES) wantRate = null;
        else { wantRate = { ...wantRate, sent: t.now, tries: wantRate.tries + 1 }; send({ do: 'rate', to: wantRate.to }); }
      }
      if (want) {
        if (r.state !== BUFFERING && otherwise(want.on, r.state) && t.now - want.sent > RESEND_MS) ask(want.on, t);
        return step();
      }
      if (wantTime || r.state === BUFFERING) return step();
      if (atEnd(applied, r, t)) { toEnd(r, t); return step(); }
      const at = positionAt(applied, t.room);
      if (Math.abs(position(t) - at) > driftAllowed(applied)) seek(at, applied.playing, t);
      if (r.rate !== applied.rate && !wantRate) rate(applied.rate, t);
      playAsParty(applied.playing, t);
      return step();
    },
  };
}
export type PartySync = ReturnType<typeof createPartySync>;
