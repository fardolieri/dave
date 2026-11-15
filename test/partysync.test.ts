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
    wait(ms: number): typeof p; friend(to: Partial<Pick<Party, 'video' | 'playing' | 'pos' | 'rate'>>): typeof p; ready(): typeof p;
    report(state: number, time: number, more?: Partial<PlayerReport>, timed?: boolean): typeof p; tick(): typeof p;
    changes(): Changed[]; mark(): () => typeof sent;
  } = {
    sent,
    get clock() { return clock; },
    /** Time passes, on both clocks. */
    wait(ms: number) { clock = { now: clock.now + ms, room: clock.room + ms }; return p; },
    /** A friend changes the party (or it is as it is when I join): from where it is now. */
    friend(to: Partial<Pick<Party, 'video' | 'playing' | 'pos' | 'rate'>>) {
      party = change(party, FRIEND, clock.room, { hash: 'h'.repeat(43), video: party?.video ?? video, playing: party?.playing ?? true, pos: party ? positionAt(party, clock.room) : 0, rate: party?.rate ?? 1, ...to });
      return take(sync.follow(party, clock));
    },
    ready: () => take(sync.ready(party, clock)),
    report: (state: number, time: number, more: Partial<PlayerReport> = {}, timed = true) => take(sync.report({ state, time, rate: 1, duration: 214, muted: false, at: clock.now, ...more }, timed, clock)),
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
});
