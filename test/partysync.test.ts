import { describe, expect, it } from 'vitest';
import { change, positionAt, type Party } from '../src/core/party';
import { BUFFERING, CUED, ENDED, PAUSED, PLAYING, UNSTARTED, createPartySync, type Changed, type Clock, type Command, type PartySync, type PlayerReport, type Step } from '../src/core/partysync';

// The player's reports as YouTube's real player sent them (probes of 2026-11-15, headless Chromium, Rick Astley's video:
// 214 s as YouTube first tells it), with what the party did between them.

const RICK = 'dQw4w9WgXcQ';
const OTHER = 'jNQXAC9IVRw';
const FRIEND = 'f'.repeat(87);

/** One player, as the app drives it: every command it was sent and every change it declared, in order. */
function player(video = RICK) {
  let clock: Clock = { now: 0, room: 1_000_000 };
  const sync: PartySync = createPartySync(video);
  const sent: Array<Command | { changed: Changed }> = [];
  let party: Party | null = null;
  const take = (s: Step) => { sent.push(...s.commands); if (s.changed) { sent.push({ changed: s.changed }); party = change(party, 'm'.repeat(87), clock.room, { ...party!, ...s.changed }); sync.took(party); } return p; };
  const p: {
    sent: typeof sent; clock: Clock; party: Party;
    wait(ms: number): typeof p; hide(hidden: boolean): typeof p; friend(to: Partial<Pick<Party, 'video' | 'playing' | 'pos' | 'rate'>>): typeof p; ready(): typeof p;
    report(state: number, time: number, more?: Partial<PlayerReport>, timed?: boolean, stated?: boolean): typeof p; tick(): typeof p;
    error(code: number): typeof p;
    changes(): Changed[]; mark(): () => typeof sent;
  } = {
    sent,
    get clock() { return clock; },
    /** Time passes, on both clocks. */
    wait(ms: number) { clock = { ...clock, now: clock.now + ms, room: clock.room + ms }; return p; },
    /** The page hidden (another app, a locked screen, a new tab), or shown again. */
    hide(hidden: boolean) { clock = { ...clock, hidden }; return p; },
    /** A friend changes the party (or it is as it is when I join): from where it is now. */
    friend(to: Partial<Pick<Party, 'video' | 'playing' | 'pos' | 'rate'>>) {
      party = change(party, FRIEND, clock.room, { hash: 'h'.repeat(43), video: party?.video ?? video, playing: party?.playing ?? true, pos: party ? positionAt(party, clock.room) : 0, rate: party?.rate ?? 1, ...to });
      return take(sync.follow(party, clock));
    },
    ready: () => take(sync.ready(party, clock)),
    report: (state: number, time: number, more: Partial<PlayerReport> = {}, timed = true, stated = true) => take(sync.report({ state, time, rate: 1, duration: 214, muted: false, at: clock.now, ...more }, timed, clock, stated)),
    error: (code: number) => take(sync.error(code)),
    tick: () => take(sync.tick(clock)),
    /** Every change the player declared for the party. */
    changes: () => sent.filter((c): c is { changed: Changed } => 'changed' in c).map((c) => c.changed),
    /** What was sent from now on. */
    mark: () => { const from = sent.length; return () => sent.slice(from); },
    get party() { return party!; },
  };
  return p;
}

/** A player that joined the party playing from 20 s, and has played in step a few seconds since. */
function playingInStep() {
  const p = player();
  p.friend({ playing: true, pos: 20 });
  p.report(CUED, 0);
  p.wait(900).ready();
  p.wait(130).report(UNSTARTED, 0).report(BUFFERING, 0).report(UNSTARTED, 0);
  p.wait(540).report(PLAYING, 20.95);
  for (let i = 0; i < 12; i++) p.wait(250).report(PLAYING, 20.95 + (i + 1) * 0.25);
  p.wait(250).tick();
  expect(p.changes()).toEqual([]);
  return p;
}

/** A player that joined the party paused at `pos`, and is held there: played muted, paused, unmuted. */
function heldPaused(pos = 30) {
  const p = player();
  p.friend({ playing: false, pos });
  p.report(CUED, 0);
  p.wait(900).ready();
  p.wait(100).report(UNSTARTED, 0, { muted: true }).report(BUFFERING, 0, { muted: true }).report(UNSTARTED, 0, { muted: true });
  p.wait(500).report(PLAYING, pos + 0.02, { muted: true });
  p.wait(60).report(PAUSED, pos + 0.08, { muted: true });
  p.wait(20).report(PAUSED, pos + 0.08);
  for (let i = 0; i < 3; i++) p.wait(1000).tick();
  expect(p.changes()).toEqual([]);
  return p;
}

const did = (cs: Array<Command | { changed: Changed }>) => cs.map((c) => ('changed' in c ? 'changed' : c.do));

describe('a watch party\'s player (core/partysync.ts)', () => {
  it('takes a friend\'s pause that comes while it is still buffering their seek, and is not taken for its own play', () => {
    // Review of #146 (Fable), probe A: the friend seeks, and pauses 155 ms later, before this player has played there.
    const p = playingInStep();
    const seeked = p.mark();
    p.friend({ pos: 150 });
    p.wait(15).report(BUFFERING, 150.001);
    p.wait(155).friend({ playing: false, pos: 150.15 });
    p.wait(366).report(PLAYING, 150.194);
    // Not the friend's play: the app asked it to pause, and asks again.
    expect(p.changes()).toEqual([]);
    expect(did(seeked()).at(-1)).toBe('pause');
    p.wait(40).report(PAUSED, 150.23);
    for (let i = 0; i < 5; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
    expect(p.party.playing).toBe(false);
  });

  it('plays when a friend pauses and plays again at once, and the pause\'s own report is not taken for theirs', () => {
    // Probe C: the friend's pause and play 20 ms apart; the player still says it plays when the play comes.
    const p = playingInStep();
    const both = p.mark();
    p.friend({ playing: false, pos: 24.643 });
    p.wait(20).friend({ playing: true, pos: 24.643 });
    expect(did(both()).lastIndexOf('play')).toBeGreaterThan(did(both()).lastIndexOf('pause'));
    p.wait(14).report(PAUSED, 24.643);
    p.wait(9).report(BUFFERING, 24.643);
    p.wait(527).report(PLAYING, 24.7);
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
    expect(p.party.playing).toBe(true);
  });

  it('stays at the end once the video has ended, though the party changes speed', () => {
    // Probe J: a speed change 4 s after the end sent a seek past it and a play, which YouTube starts from 0 s with.
    const p = playingInStep();
    p.friend({ playing: true, pos: 206 });
    p.wait(20).report(BUFFERING, 206).wait(300).report(PLAYING, 206.1);
    for (let t = 206.1; t < 213; t += 0.5) p.wait(500).report(PLAYING, t);
    p.wait(100).report(ENDED, 213.061);
    for (let i = 0; i < 4; i++) p.wait(1000).tick();
    const after = p.mark();
    p.friend({ rate: 1.5 });
    expect(did(after())).toEqual(['rate']);
    p.wait(40).report(ENDED, 213.061, { rate: 1.5 });
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    expect(did(after())).toEqual(['rate']);
    expect(p.changes()).toEqual([]);
  });

  it('pauses where a friend paused a moment before the end, though its own video had ended', () => {
    // Probe J3: a seek on an ended video plays it (YouTube's way), which was taken for this friend's play.
    const p = playingInStep();
    p.friend({ playing: true, pos: 207 });
    p.wait(20).report(PLAYING, 207);
    p.wait(6000).report(ENDED, 213.061);
    const after = p.mark();
    p.wait(400).friend({ playing: false, pos: 212.2 });
    p.wait(27).report(PLAYING, 212.2);
    p.wait(19).report(BUFFERING, 212.2);
    p.wait(120).report(PAUSED, 212.2);
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
    expect(did(after())).not.toContain('play');
    expect(did(after())).toContain('pause');
  });

  it('joins a party that played past the end at the end, not from the start on its own', () => {
    // Probe J2: a seek past the end of a video that has not started plays it from 0 s.
    const p = player();
    p.friend({ playing: true, pos: 400 });
    p.report(CUED, 0);
    const joined = p.mark();
    p.wait(900).ready();
    const seeks = joined().filter((c): c is { do: 'seek'; to: number } => 'do' in c && c.do === 'seek');
    expect(seeks.length).toBeGreaterThan(0);
    expect(seeks.every((s) => s.to < 214)).toBe(true);
  });

  it('holds another card paused at its start, though its last report of the video before told it played', () => {
    // Review of #146 (Fable), staged: joined while playing (never given a video by load), then another card is put on
    // paused; a report of the time alone, on its way since before, keeps the state told before (playing).
    const p = playingInStep();
    const after = p.mark();
    p.friend({ video: OTHER, playing: false, pos: 0 });
    expect(did(after())).toEqual(['mute', 'load']);
    p.report(PLAYING, 24.9, { muted: true });
    // The new video loading, as YouTube tells it over one that played: buffering, paused at 0, then unstarted.
    p.wait(20).report(BUFFERING, 0, { muted: true }).report(PAUSED, 0, { muted: true }).report(UNSTARTED, 0, { muted: true });
    expect(did(after())).not.toContain('unMute');
    p.wait(300).report(BUFFERING, 0, { muted: true }).report(UNSTARTED, 0, { muted: true });
    p.wait(400).report(PLAYING, 0.02, { muted: true });
    p.wait(60).report(PAUSED, 0.08, { muted: true });
    expect(did(after())).toEqual(['mute', 'load', 'pause', 'unMute']);
    expect(p.changes()).toEqual([]);
  });
  // Second review of #146 (Fable), on the rework: the sequences it confirmed on YouTube's real player, and the halves of
  // the rule no test held (asked again until done, and not let go meanwhile).

  it('asks a pause again while the player plays on, and never lets it go by time alone', () => {
    const p = playingInStep();
    p.friend({ playing: false, pos: 24.2 });
    // It buffers for long (a slow link), then plays: not the friend's, and asked again at once.
    p.wait(20).report(BUFFERING, 24.2);
    for (let i = 0; i < 6; i++) p.wait(1000).tick();
    const after = p.mark();
    p.wait(100).report(PLAYING, 24.3);
    expect(did(after())).toEqual(['pause']);
    expect(p.changes()).toEqual([]);
    p.wait(40).report(PAUSED, 24.35);
    expect(p.party.playing).toBe(false);
  });

  it('asks a play again, after a while, of a player that stays paused, from its reports and from the tick', () => {
    const p = heldPaused(30);
    p.friend({ playing: true });
    const after = p.mark();
    p.wait(20).report(PAUSED, 30.08); // from before the play
    expect(did(after())).toEqual([]);
    p.wait(1100).report(PAUSED, 30.08);
    expect(did(after())).toEqual(['play']);
    p.wait(1100).tick();
    expect(did(after())).toEqual(['play', 'play']);
    p.wait(50).report(PLAYING, 30.1);
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    // Done: not asked again (put forward to where the party is by now, though).
    expect(did(after()).filter((c) => c === 'play')).toEqual(['play', 'play']);
    expect(p.changes()).toEqual([]);
  });

  it('does not take a pause and play together for done on the tick, nor on a report of the time alone', () => {
    // Probe toggleAtTick: the tick read the player's last report, playing still, as the play done.
    for (const between of ['tick', 'time alone'] as const) {
      const p = playingInStep();
      p.friend({ playing: false, pos: 24.643 });
      p.wait(20).friend({ playing: true, pos: 24.643 });
      if (between === 'tick') p.wait(5).tick();
      else p.wait(5).report(PLAYING, 24.66, {}, true, false);
      p.wait(9).report(PAUSED, 24.643);
      p.wait(9).report(BUFFERING, 24.643);
      p.wait(300).report(PLAYING, 24.7);
      for (let i = 0; i < 3; i++) p.wait(1000).tick();
      expect(p.changes(), between).toEqual([]);
    }
  });

  it('keeps holding a player whose hold a friend\'s paused seek comes into: no pause of its own meanwhile', () => {
    // Probe changeDuringHold: the pause sent into the hold's loading kept the player from ever starting.
    const p = player();
    p.friend({ playing: false, pos: 10 });
    p.report(CUED, 0);
    p.wait(900).ready();
    p.wait(100).report(UNSTARTED, 0, { muted: true }).report(BUFFERING, 0, { muted: true });
    const after = p.mark();
    p.wait(200).friend({ pos: 150 });
    expect(did(after())).not.toContain('pause');
    p.wait(300).report(PLAYING, 150.02, { muted: true });
    p.wait(60).report(PAUSED, 150.08, { muted: true });
    expect(did(after()).slice(-2)).toEqual(['pause', 'unMute']);
    expect(p.changes()).toEqual([]);
  });

  it('holds again a player that never played, paused again before it could, and takes my own play after', () => {
    // Probe stuckShot: a pause sent to a player still loading never came true, and swallowed my own play for good.
    const p = player();
    p.friend({ playing: false, pos: 0 });
    p.report(CUED, 0);
    p.wait(900).ready();
    p.wait(100).report(UNSTARTED, 0, { muted: true });
    p.wait(200).friend({ playing: true });
    const after = p.mark();
    p.wait(100).friend({ playing: false });
    expect(did(after())).toEqual(['mute', 'load']);
    p.wait(100).report(UNSTARTED, 0, { muted: true }).report(BUFFERING, 0, { muted: true }).report(UNSTARTED, 0, { muted: true });
    p.wait(400).report(PLAYING, 0.36, { muted: true });
    p.wait(60).report(PAUSED, 0.4, { muted: true });
    p.wait(20).report(PAUSED, 0.4);
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
    // I press play in YouTube's player: everyone plays.
    p.wait(500).report(PLAYING, 0.4);
    expect(p.changes()).toEqual([{ playing: true, pos: 0.4, rate: 1 }]);
  });

  it('plays a player paused near the end once the party, played again, is past it', () => {
    // Probe lateEnd: no command at all, the player left paused while the party played out.
    const p = heldPaused(211);
    const after = p.mark();
    p.friend({ playing: true, pos: 213.5 });
    expect(did(after())).toContain('play');
  });

  it('asks nothing more of a player YouTube refuses the video to, until another one', () => {
    // Probe badVideo: error 150, then a play every second or two, or a cue every second, for good.
    const p = player();
    p.friend({ playing: true, pos: 20 });
    p.report(CUED, 0);
    p.wait(900).ready();
    p.wait(200).report(UNSTARTED, 0).error(150);
    const after = p.mark();
    for (let i = 0; i < 20; i++) p.wait(1000).tick();
    p.friend({ playing: false, pos: 40 });
    for (let i = 0; i < 20; i++) p.wait(1000).tick();
    expect(did(after())).toEqual([]);
    p.friend({ video: OTHER, playing: true, pos: 0 });
    expect(did(after())).toContain('load');
  });
  // Third review of #146 (Fable): what the second one's fixes still got wrong.

  it('unmutes a player held when YouTube refuses its video, and holds the next card as a new player would', () => {
    // Probe errThenAnother: the hold dropped without its unmute, and the next card muted for good.
    const p = player();
    p.friend({ playing: false, pos: 0 });
    p.report(CUED, 0);
    p.wait(900).ready();
    p.wait(100).report(UNSTARTED, 0, { muted: true });
    const after = p.mark();
    p.wait(50).error(150);
    expect(did(after())).toEqual(['unMute']);
    p.wait(2000).friend({ video: OTHER, playing: false, pos: 0 });
    // After a refused video the player tells of the new one at once, buffering, then playing.
    p.wait(100).report(BUFFERING, 0, { muted: true });
    p.wait(400).report(PLAYING, 0.02, { muted: true });
    p.wait(60).report(PAUSED, 0.08, { muted: true });
    expect(did(after())).toEqual(['unMute', 'mute', 'load', 'pause', 'unMute']);
    expect(p.changes()).toEqual([]);
  });

  it('unmutes a player held again before it told back the unmute of the hold before', () => {
    // Probe holdPlayPauseMuted: a play and a pause close together; the second hold took the app's own mute for the friend's.
    const p = player();
    p.friend({ playing: false, pos: 0 });
    p.report(CUED, 0);
    p.wait(900).ready();
    p.wait(100).report(UNSTARTED, 0, { muted: true });
    const after = p.mark();
    p.wait(200).friend({ playing: true });
    p.wait(30).friend({ playing: false });
    p.wait(100).report(UNSTARTED, 0, { muted: true }).report(BUFFERING, 0, { muted: true });
    p.wait(400).report(PLAYING, 0.3, { muted: true });
    p.wait(60).report(PAUSED, 0.35, { muted: true });
    expect(did(after()).at(-1)).toBe('unMute');
    expect(p.changes()).toEqual([]);
  });

  it('lets a pause go, a while after, that a player paused already never answers, and takes my own play after', () => {
    // Modelled: a browser that refuses a play nobody pressed for; a friend plays, then pauses; then I press play.
    const p = heldPaused(30);
    p.friend({ playing: true });
    p.wait(100).friend({ playing: false });
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    p.wait(500).report(PLAYING, 30.1);
    expect(p.changes()).toEqual([{ playing: true, pos: 30.1, rate: 1 }]);
  });
  // Fourth review of #146 (Opus): a phone pauses the player of a page it hides, by itself.

  it('does not take the pause of a page hidden for the friend\'s, and plays on with the party once shown again', () => {
    // Probe hidden (phone profiles): YouTube paused the player as the page went hidden, and everyone's paused.
    const p = playingInStep();
    p.hide(true);
    p.wait(30).report(PAUSED, 24.3);
    for (let i = 0; i < 5; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
    expect(p.party.playing).toBe(true);
    const shown = p.mark();
    p.hide(false).wait(200).tick();
    expect(did(shown())).toEqual(['seek', 'play']);
    p.wait(30).report(BUFFERING, 29.5).wait(300).report(PLAYING, 29.6);
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
  });
  // Fifth review of #146 (Opus), on the hidden page.

  it('asks its speed again of a player shown again, which a phone reloads at 1x while it says it plays faster', () => {
    // Probe hiddenRateLoop (phone profiles): the video played at 1x, put forward every 3 s, for good.
    const p = playingInStep();
    p.friend({ rate: 1.5 });
    p.wait(40).report(PLAYING, 24.5, { rate: 1.5 });
    for (let i = 0; i < 3; i++) p.wait(1000).report(PLAYING, 24.5 + 1.5 * (i + 1), { rate: 1.5 });
    p.hide(true).wait(30).report(PAUSED, 29, { rate: 1.5 });
    p.wait(5000).tick();
    const shown = p.mark();
    p.hide(false).wait(200).tick();
    p.wait(300).report(BUFFERING, 37, { rate: 1.5 }).wait(400).report(PLAYING, 37.1, { rate: 1.5 });
    expect(did(shown())).toEqual(['seek', 'play', 'rate', 'rate']);
    expect(shown().filter((c): c is { do: 'rate'; to: number } => 'do' in c && c.do === 'rate').map((c) => c.to)).toEqual([1, 1.5]);
    // A report of the time, saying the speed asked, before the player's answer to 1x: that answer is not the friend's.
    p.wait(4).report(PLAYING, 37.12, { rate: 1.5 }, true, false);
    p.wait(4).report(PLAYING, 37.15, { rate: 1 }).wait(300).report(PLAYING, 37.6, { rate: 1.5 });
    expect(p.changes()).toEqual([]);
  });

  it('does not take the answer to a seek asked while the page was hidden, come once shown, for the friend\'s', () => {
    // Probe hiddenSeekPause: the seek was given up after 4 s; its answer after showing was declared as a seek.
    const p = playingInStep();
    p.hide(true).wait(30).report(PAUSED, 24.3);
    p.wait(1000).friend({ playing: false, pos: 37.75 });
    for (let i = 0; i < 6; i++) p.wait(1000).tick();
    // Its answer comes 0.19 s after the page shows, before the tick, after a word of YouTube's that tells no time.
    p.hide(false).wait(10).report(PAUSED, 24.3, {}, false, false);
    p.wait(180).report(PAUSED, 37.75, {}, true, false).wait(100).report(PAUSED, 37.75);
    for (let i = 0; i < 3; i++) p.wait(1000).tick();
    expect(p.changes()).toEqual([]);
  });

  it('keeps a player that plays in a hidden tab in step: a desktop browser plays on', () => {
    // Probe A's reports in a background tab: the pause was not asked again, and the player played on, heard.
    const p = playingInStep();
    p.hide(true);
    p.friend({ pos: 150 });
    p.wait(15).report(BUFFERING, 150.001);
    p.wait(155).friend({ playing: false, pos: 150.15 });
    const after = p.mark();
    p.wait(366).report(PLAYING, 150.194);
    expect(did(after())).toEqual(['pause']);
    p.wait(30).report(PAUSED, 150.22);
    expect(p.changes()).toEqual([]);
    // Played again, and falls behind in the background: put forward.
    p.friend({ playing: true });
    p.wait(30).report(PLAYING, 150.2);
    p.wait(6000).report(PLAYING, 151);
    const behind = p.mark();
    p.wait(1000).tick();
    expect(did(behind())).toContain('seek');
  });
  // Seventh review of #146 (Opus): the speed asked again after showing must not quiet the press that sets it off.

  it('takes my own play, minutes after the page was shown again, at another speed', () => {
    // Probe play1 (desktop): the play that set off the speed's asking again fell in its quiet second, and was undone.
    const p = heldPaused(30);
    p.friend({ rate: 1.5 });
    p.wait(40).report(PAUSED, 30.08, { rate: 1.5 });
    p.hide(true).wait(5000).tick();
    p.hide(false);
    for (let i = 0; i < 10; i++) p.wait(1000).tick();
    p.wait(500).report(BUFFERING, 30.08, { rate: 1.5 }).wait(200).report(PLAYING, 30.1, { rate: 1.5 });
    expect(p.changes()).toEqual([{ playing: true, pos: 30.1, rate: 1.5 }]);
  });
});
