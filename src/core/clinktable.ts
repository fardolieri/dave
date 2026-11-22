// Clink at one app's table (core/clink.ts): what it hears from the other players and sends them, who leads, the round
// it follows or runs, the climbs it works out from the round's seed, its own seat, and what happened, for
// client/clink.ts to draw and sound. No screen here, and no clock of its own: tests run many tables against each other
// (test/clinktable.test.ts). Runtime-neutral: plain data and the links' three calls.
import {
  advance, buy, canFlip, climbAt, climbsTo, earn, flip, flipStake, follow, grab, matchFrame, newSeat, newSeed, parseFrame, phaseOrder, rankOf,
  rollsOf, seatFrame,
  CLIMBS, COUNT_MS, PAUSE_MS, RIDING, TOP,
  type Climb, type Counted, type Roll, type Script, type Seat, type SeatFrame, type Share, type Upgrade,
} from './clink';
import { firstRound, leaderOf, roundFrame, roundOf, whoOf, type Round } from './rounds';

/** The game links as a table uses them (client/gamelinks.ts). */
export type Wire = { broadcast(data: string): void; listen(f: (from: string, data: unknown) => void): () => void; connected(): string[] };

export const SEND_MS = 100;
export const ROUND_SEND_MS = 250;
/** Heard from this lately: here. */
export const HEARD_MS = 2500;
/**
 * Not heard from for longer, but their link still open: away a while (a phone put down, a tab in the background), still
 * in the match. A friend who leaves the game closes their links (client/gamelinks.ts).
 */
export const AWAY_MS = 20_000;
/** What happened longer ago than this, nobody saw happen: not drawn or sounded when the screen comes back. */
export const STALE_MS = 1000;
/**
 * Back after a gap longer than the others take to stop hearing an app (a phone woken, a tab long in the background):
 * this long following whoever leads before leading, so as not to end a match the others already ended, with chips heard
 * before the gap. Its frames say so (`hd`). A tab in the background whose timer comes once a second, or one that stalls
 * a moment, is no such gap: it leads on.
 */
export const HOLD_MS = 800;
/** A gap this long holds back: shorter than the others take to stop hearing an app, so it never counts a friend it missed. */
const GAP_MS = 2000;
/** A double or nothing in time on a friend's screen, which may run behind the leader's by a frame's way and more. */
const DOUBLE_SLACK_MS = 500;

/** What happened, for the screen: when, and in which climb (`climbId`). */
export type Happening = { at: number; climb: string } & (
  | { kind: 'land'; h: number; gold: boolean } | { kind: 'fell' } | { kind: 'top' } | { kind: 'grab'; who: string; won: number; h: number }
  | { kind: 'gilded'; who: string; amount: number } | { kind: 'flip'; who: string; win: boolean; amount: number } | { kind: 'interest'; amount: number }
  | { kind: 'beep' } | { kind: 'go' } | { kind: 'won' }
);

export type Other = { key: string; frame: SeatFrame; at: number };

export type Table = ReturnType<typeof createTable>;

/**
 * For tests: the dice rolled as `value` from after a coin on (`from`: climb, coin, of the climbs of `epoch`; every coin
 * of a later round's), whatever the seed says; NaN, the seed's again.
 */
type Rig = { epoch: number; from: [number, number]; value: number };

/** One app's table: me (`me`, my key), over `wire`, chance (seeds) from `rand`, the time from `clock` (ms). */
export function createTable(me: string, wire: Wire, rand: () => number, clock: () => number) {
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  let round: Round = firstRound(clock());
  let seed = newSeed(rand);
  let seat: Seat = newSeat();
  /** The match I play; 0 while I watch one, or none is on (waiting, I practise). */
  let playing = 0;
  let leader: string | null = me;
  const roundSeq = new Map<string, number>();
  let sentQ = 0;
  let last = clock();
  let holdUntil = 0;
  let lastSeatSent = -Infinity, lastRoundSent = -Infinity;
  let lastBeep = -1;
  let happened: Happening[] = [];
  let rigs: Rig[] = [];
  /** Counts the rounds' climbs: another round, phase or seed, another count (a start put right is the same climbs). */
  let epoch = 0;
  /** The climbs worked out so far, of this round's seed and start; and the climb as it stood when last looked at. */
  let known: Script[] = [];
  let climb: Climb | null = null;

  const rolls: Roll = (c, k, what) => {
    const rig = rigs.find((r) => r.epoch < epoch || c > r.from[0] || (c === r.from[0] && k > r.from[1]));
    return rig && !Number.isNaN(rig.value) ? rig.value : rollsOf(seed)(c, k, what);
  };
  /** The climb going on at `at`: practice's while waiting, the match's while playing, none counting down or after. */
  const climbNow = (at: number): Climb | null => {
    if (round.phase !== 'wait' && round.phase !== 'play') return null;
    const s = climbsTo(known, rolls, round.since, at, round.phase === 'play' ? CLIMBS : Infinity);
    return s ? climbAt(s, at - s.t0) : null;
  };
  /**
   * The match is over: its last climb, and the pause after it, are. Counted only on chips heard since a double or
   * nothing could last change them (`lateForDouble`): a leader back from a moment away waits for everyone's word.
   */
  const matchOver = (at: number, around: readonly Other[]) => {
    if (round.phase !== 'play' || climbsTo(known, rolls, round.since, at, CLIMBS) !== null) return false;
    const last = known[known.length - 1]!;
    const cutoff = last.t0 + last.end + PAUSE_MS - 1000 + DOUBLE_SLACK_MS;
    return around.every((o) => o.at >= cutoff);
  };
  const climbIdOf = (cl: Climb | null): string => (cl ? `${round.n}:${round.phase}:${seed}:${cl.c}` : '');
  const tell = (h: Record<string, unknown> & { kind: Happening['kind'] }, at: number) => happened.push({ ...h, at, climb: climbIdOf(climb) } as Happening);
  const watching = () => playing === 0 && (round.phase === 'count' || round.phase === 'play');
  /** Whether my seat is in the climb going on: while waiting, every climb is practice for whoever is there. */
  const seated = () => round.phase === 'wait' || (round.phase === 'play' && playing === round.n && playing > 0);
  const heard = (at: number): Other[] => [...others.values()].filter((o) => at - o.at < HEARD_MS);
  const present = (at: number): Other[] => {
    const open = new Set(wire.connected());
    return [...others.values()].filter((o) => at - o.at < HEARD_MS || (at - o.at < AWAY_MS && open.has(o.key)));
  };
  /**
   * The match's last climb is over: my chips are what they are, for the leader to count once it ends (no allowance
   * now; a double or nothing only early in the pause, while there is time for the leader to hear how it went).
   */
  const settled = () => round.phase === 'play' && climb !== null && climb.c >= CLIMBS && climb.fell >= 0;
  /** Too late for a double or nothing: near the end of the last climb's pause, or after it while the match is ending. */
  const lateForDouble = (at: number) => round.phase === 'play' && (climbNow(at) === null || (settled() && climb !== null && at - climb.t0 > climb.fell + PAUSE_MS - 1000));

  /** The round as it now is, and its seed: another start or seed, other climbs; another round or phase, a new seat. */
  const took = (next: Round, nextSeed: number, at: number) => {
    const was = round;
    if (next.n !== was.n || next.phase !== was.phase || nextSeed !== seed) epoch++;
    if (next.since !== was.since || nextSeed !== seed) { seed = nextSeed; known = []; climb = null; }
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    if (next.phase === 'count') {
      playing = next.players.includes(myWho) ? next.n : 0;
      seat = { ...newSeat(), share: seat.share };
    } else if (next.phase === 'play') {
      if (playing !== next.n) playing = 0;
      else tell({ kind: 'go' }, at);
    } else if (next.phase === 'wait') {
      playing = 0;
      seat = { ...newSeat(), share: seat.share };
    } else if (next.phase === 'over' && next.winner === myWho && playing === next.n) tell({ kind: 'won' }, at);
  };

  const off = wire.listen((from, data) => {
    const f = parseFrame(data);
    if (!f) return;
    const at = clock();
    if (f.k === 's') {
      const was = others.get(from)?.frame;
      others.set(from, { key: from, frame: f, at });
      if (was && was.c === f.c) {
        if (was.a === RIDING && f.a >= 0) tell({ kind: 'grab', who: from, won: f.w, h: f.a }, at);
        if (f.g > was.g) tell({ kind: 'gilded', who: from, amount: f.g - was.g }, at);
        if (was.f === 0 && f.f !== 0) tell({ kind: 'flip', who: from, win: f.f === 1, amount: Math.max(0, f.w - f.st) }, at);
      }
      return;
    }
    // Only the leader's, and never a round, or a phase of it, older than mine: a leader's rounds only go on (an app
    // reloaded under the leader's key starts again from none, and is not followed back there).
    if (from !== leader || rankOf(f.n, f.ph) < rankOf(round.n, round.phase) || f.q <= (roundSeq.get(from) ?? -1)) return;
    roundSeq.set(from, f.q);
    const next = roundOf(f, at);
    // The same round keeps its start, unless the leader's says otherwise by more than a frame's wander.
    const same = next.n === round.n && next.phase === round.phase && f.s === seed && Math.abs(next.since - round.since) < 150;
    took(same ? { ...next, since: round.since } : next, f.s, at);
  });

  /** The table at `at`: what was heard taken in, the round led if mine, the climb worked out, my seat followed, my frames sent. */
  function step(at: number): void {
    const dt = at - last;
    if (dt > GAP_MS) holdUntil = at + HOLD_MS;
    last = at;
    const around = heard(at);
    const holding = at < holdUntil;
    // Who leads: of those who know the newest round and phase, holding back or not, the smallest key not holding back;
    // none, while all of them hold back (one who knows less never leads in their place).
    const ranked = [{ key: me, n: rankOf(round.n, round.phase), hold: holding }, ...around.map((o) => ({ key: o.key, n: o.frame.n * 4 + o.frame.po, hold: o.frame.hd }))];
    const top = Math.max(...ranked.map((p) => p.n));
    leader = leaderOf(ranked.filter((p) => p.n === top && !p.hold));
    if (leader === me) {
      const counted = (o: Other): Counted => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n, chips: o.frame.ch });
      const mine: Counted = { who: myWho, n: playing, known: round.n, chips: seat.chips };
      const next = advance({ round, seed }, at, [mine, ...around.map(counted)], [mine, ...present(at).map(counted)], rand, matchOver(at, around));
      if (next.round !== round || next.seed !== seed) { took(next.round, next.seed, at); lastRoundSent = -Infinity; }
      if (at - lastRoundSent >= ROUND_SEND_MS) { sentQ = Math.max(Date.now(), sentQ + 1); wire.broadcast(JSON.stringify(matchFrame(roundFrame(round, at, sentQ), seed))); lastRoundSent = at; }
    }
    // The climb, and what changed in it since the last step.
    const was = climb;
    climb = climbNow(at);
    if (climb && was && climb.c === was.c) {
      for (let k = was.h + 1; k <= climb.h; k++) tell({ kind: 'land', h: k, gold: climb.gold.some(([g]) => g === k) }, at);
      if (climb.fell >= 0 && was.fell < 0) tell({ kind: climb.h >= TOP ? 'top' : 'fell' }, at);
    }
    // My seat, as the climb goes.
    if (seated()) {
      if (!settled()) seat = earn(seat, dt);
      if (climb) {
        const before = seat;
        seat = follow(seat, climb, at - climb.t0);
        if (seat.gilded > before.gilded && seat.c === before.c) tell({ kind: 'gilded', who: me, amount: seat.gilded - before.gilded }, at);
        if (seat.interest > 0 && before.interest < 0 && seat.c === before.c) tell({ kind: 'interest', amount: seat.interest }, at);
        if (before.at === RIDING && seat.at >= 0) tell({ kind: 'grab', who: me, won: seat.won, h: seat.at }, at);
        const left = Math.ceil((climb.bet - (at - climb.t0)) / 1000);
        if (left !== lastBeep && left >= 1 && left <= 3) { lastBeep = left; tell({ kind: 'beep' }, at); }
      }
    }
    if (round.phase === 'count' && !watching()) {
      const left = Math.ceil((COUNT_MS - (at - round.since)) / 1000);
      if (left !== lastBeep && left >= 1 && left <= 3) { lastBeep = left; tell({ kind: 'beep' }, at); }
    }
    if (at - lastSeatSent >= SEND_MS) {
      wire.broadcast(JSON.stringify(seatFrame(seat, watching() ? 0 : playing, round.n, phaseOrder(round.phase), holding)));
      lastSeatSent = at;
    }
    happened = happened.filter((h) => at - h.at <= STALE_MS);
  }

  /** Whether a grab now is one: on the tower, the stakes closed, and the next coin not yet due. */
  const canGrab = (at: number): boolean => {
    const cl = climbNow(at);
    if (!seated() || !cl || seat.at !== RIDING || seat.c !== cl.c || cl.fell >= 0) return false;
    const ms = at - cl.t0;
    return ms >= cl.bet && ms < cl.next;
  };

  return {
    step,
    canGrab,
    /** Whether a double or nothing now is one. */
    canFlip: (at: number): boolean => seated() && canFlip(seat) && !lateForDouble(at),
    grab(at: number): void { if (canGrab(at)) { seat = grab(seat, climbNow(at)!.h); tell({ kind: 'grab', who: me, won: seat.won, h: seat.at }, at); lastSeatSent = -Infinity; } },
    flip(roll: number, at: number): void {
      if (!seated() || !canFlip(seat) || lateForDouble(at)) return;
      const amount = flipStake(seat);
      seat = flip(seat, roll);
      tell({ kind: 'flip', who: me, win: seat.flip === 1, amount }, at);
      lastSeatSent = -Infinity;
    },
    share(s: Share): void { seat = { ...seat, share: s }; },
    buy(u: Upgrade): boolean { if (!seated()) return false; const next = buy(seat, u); if (next === seat) return false; seat = next; lastSeatSent = -Infinity; return true; },
    /**
     * For tests: every roll `value` (null: the seed's again) after coin `from` (climb, coin) of this round's climbs, and
     * all of later rounds'; by default from the next coin not seen yet here, after a fall the next climb's. Tables rigged
     * alike from the same coin work out the same towers.
     */
    rig(value: number | null, at: number, from?: [number, number]): void {
      const cl = climbNow(at);
      from ??= !cl ? [0, 0] : cl.fell >= 0 ? [cl.c + 1, 0] : [cl.c, cl.h];
      rigs = [{ epoch, from, value: value ?? NaN }, ...rigs].slice(0, 16);
      known = known.filter((s) => s.c < from[0]);
    },
    /** What happened since the last call, but what is too old to show. */
    drain(at: number): Happening[] { const out = happened.filter((h) => at - h.at <= STALE_MS); happened = []; return out; },
    get round(): Round { return round; },
    get climb(): Climb | null { return climb; },
    get seat(): Seat { return seat; },
    get leader(): string | null { return leader; },
    get playing(): number { return playing; },
    climbId: (): string => climbIdOf(climb),
    watching,
    seated,
    heard,
    present,
    others: (): ReadonlyMap<string, Other> => others,
    close(): void { off(); },
  };
}
