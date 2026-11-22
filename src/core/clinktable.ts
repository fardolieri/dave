// Clink at one app's table (core/clink.ts): what it hears from the other players and sends them, who leads, the round
// and the climb it follows or runs, its own seat, and what happened, for client/clink.ts to draw and sound. No screen
// here, and no clock of its own: the time comes in with every call, so tests run many tables against each other
// (test/clinktable.test.ts). Runtime-neutral: plain data and the links' three calls.
import {
  advance, buy, canFlip, climbFrame, climbOf, clinkMs, earn, flip, flipStake, follow, grab, newSeat, parseFrame, seatFrame,
  CLIMBS, COUNT_MS, PAUSE_MS, RIDING, TOP,
  type Climb, type Counted, type Seat, type SeatFrame, type Share, type Upgrade,
} from './clink';
import { firstRound, leaderOf, roundFrame, roundOf, whoOf, type Round } from './rounds';

/** The game links as a table uses them (client/gamelinks.ts). */
export type Wire = { broadcast(data: string): void; listen(f: (from: string, data: unknown) => void): () => void; connected(): string[] };

export const SEND_MS = 100;
export const ROUND_SEND_MS = 250;
export const CLIMB_SEND_MS = 150;
/** Heard from this lately: in the running to lead. */
export const HEARD_MS = 2500;
/**
 * Not heard from for longer, but their link still open: away a while (a phone put down, a tab in the background), still
 * in the match, their stake riding as it was. A friend who leaves the game closes their links (client/gamelinks.ts).
 */
export const AWAY_MS = 20_000;
/** Back after a gap (a tab come back, a phone woken): this long hearing the others before leading again. */
export const HOLD_MS = 800;
const GAP_MS = 1000;
/** What happened longer ago than this, nobody saw happen: not drawn or sounded when the screen comes back. */
export const STALE_MS = 1000;

/**
 * Who leads, as a number to rank by (core/rounds.ts, `leaderOf`): who knows the newest round, then the newest climb of
 * it, then one who may lead (a visible tab, not just back) over one who may not; then the smaller key. A friend who just
 * came in, or came back, knows no climb of the round yet, and takes over nobody's tower with one of their own.
 */
export const rankOf = (n: number, climb: number, may: boolean): number => n * 512 + Math.min(climb, 255) * 2 + (may ? 1 : 0);

/** What happened, for the screen: when, and in which climb (`climbIdOf`). */
export type Happening = { at: number; climb: string } & (
  | { kind: 'land'; h: number; gold: boolean } | { kind: 'fell' } | { kind: 'top' } | { kind: 'grab'; who: string; won: number; h: number }
  | { kind: 'gilded'; who: string; amount: number } | { kind: 'flip'; who: string; win: boolean; amount: number } | { kind: 'interest'; amount: number }
  | { kind: 'beep' } | { kind: 'go' } | { kind: 'won' }
);

export type Other = { key: string; frame: SeatFrame; at: number };

export type Table = ReturnType<typeof createTable>;

/** One app's table: me (`me`, my key), over `wire`, the leader's chance from `rand`, the time from `clock` (ms). */
export function createTable(me: string, wire: Wire, rand: () => number, clock: () => number) {
  const now = clock();
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  let round: Round = firstRound(now);
  let climb: Climb | null = null;
  let seat: Seat = newSeat();
  /** The match I play; 0 while I watch one, or none is on (waiting, I practise). */
  let playing = 0;
  let leader: string | null = me;
  let wasLeader = false;
  const roundSeq = new Map<string, number>();
  const climbSeq = new Map<string, number>();
  let sentQ = 0;
  let last = now;
  let holdUntil = 0;
  let lastSeatSent = -Infinity, lastRoundSent = -Infinity, lastClimbSent = -Infinity;
  let lastBeep = -1;
  let happened: Happening[] = [];

  const climbIdOf = (cl: Climb | null): string => (cl ? `${round.n}:${round.phase === 'wait' ? 'practice' : 'match'}:${cl.c}` : '');
  const tell = (h: Record<string, unknown> & { kind: Happening['kind'] }, at: number) => happened.push({ ...h, at, climb: climbIdOf(climb) } as Happening);
  const watching = () => playing === 0 && (round.phase === 'count' || round.phase === 'play');
  /** Whether my seat is in the climb going on: while waiting, every climb is practice for whoever is there. */
  const seated = () => round.phase === 'wait' || (round.phase === 'play' && playing === round.n && playing > 0);
  const heard = (at: number): Other[] => [...others.values()].filter((o) => at - o.at < HEARD_MS);
  const present = (at: number): Other[] => {
    const open = new Set(wire.connected());
    return [...others.values()].filter((o) => at - o.at < HEARD_MS || (at - o.at < AWAY_MS && open.has(o.key)));
  };
  const worth = (s: { chips: number; stake: number; at: number }) => s.chips + (s.at === RIDING ? s.stake : 0);
  /**
   * The match's last climb is over: my chips are what they are, for the leader to count once it ends (no allowance
   * now; a double or nothing only early in the pause, while there is time for the leader to hear how it went).
   */
  const settled = () => round.phase === 'play' && climb !== null && climb.c >= CLIMBS && climb.fell >= 0;
  const lateForDouble = (at: number) => settled() && climb !== null && at - climb.t0 > climb.fell + PAUSE_MS - 1000;

  /** A new round, or a new phase of it: a climb belongs to the one it was of, never carried into another. */
  const took = (next: Round, at: number) => {
    const was = round;
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    climb = null;
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

  /** The climb as it now stands, from my run of it or the leader's frames; what changed, told. */
  const tookClimb = (next: Climb | null, at: number) => {
    const was = climb;
    climb = next;
    if (!next || !was || next.c !== was.c) return;
    for (let k = was.h + 1; k <= next.h; k++) tell({ kind: 'land', h: k, gold: next.gold.some(([g]) => g === k) }, at);
    if (next.fell >= 0 && was.fell < 0) tell({ kind: next.h >= TOP ? 'top' : 'fell' }, at);
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
    // Only the leader's, and never an older round's: a leader's rounds only go on (an app reloaded under the leader's
    // key starts again from none, and is not followed back there).
    if (from !== leader || f.n < round.n) return;
    if (f.k === 'r') {
      if (f.q <= (roundSeq.get(from) ?? -1)) return;
      roundSeq.set(from, f.q);
      const next = roundOf(f, at);
      took(next.n === round.n && next.phase === round.phase && Math.abs(next.since - round.since) < 150 ? { ...next, since: round.since } : next, at);
      return;
    }
    if (f.q <= (climbSeq.get(from) ?? -1) || f.n !== round.n || round.phase === 'count' || round.phase === 'over') return;
    climbSeq.set(from, f.q);
    const next = climbOf(f, at);
    // The same climb keeps its start, unless the leader's says otherwise by more than a frame's wander.
    tookClimb(climb && climb.c === next.c && Math.abs(next.t0 - climb.t0) < 150 ? { ...next, t0: climb.t0 } : next, at);
  });

  /** The table at `now`: what was heard taken in, the leader's work if mine, my seat followed, my frames sent. */
  function step(at: number, visible: boolean): void {
    const dt = at - last;
    if (dt > GAP_MS) holdUntil = at + HOLD_MS;
    last = at;
    const may = visible && at >= holdUntil;
    const around = heard(at);
    leader = leaderOf([{ key: me, n: rankOf(round.n, climb?.c ?? 0, may) }, ...around.map((o) => ({ key: o.key, n: rankOf(o.frame.n, o.frame.kc, o.frame.v) }))]);
    const leading = leader === me && may;
    if (leading) {
      // Just taken over, the next coin due or overdue: those on the tower get the time to grab first.
      if (!wasLeader && climb && climb.fell < 0 && at - climb.t0 >= climb.bet && at - climb.t0 > climb.next - 300) climb = { ...climb, next: Math.round(at - climb.t0) + clinkMs(climb.h) };
      const counted: Counted[] = [
        { who: myWho, n: playing, known: round.n, chips: worth(seat), riding: seated() && seat.at === RIDING },
        ...present(at).map((o) => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n, chips: o.frame.ch + (o.frame.a === RIDING ? o.frame.st : 0), riding: o.frame.a === RIDING && o.frame.c === climb?.c })),
      ];
      const next = advance({ round, climb }, at, counted, rand);
      if (next.round !== round) { took(next.round, at); lastRoundSent = -Infinity; }
      if (next.climb !== climb) { tookClimb(next.climb, at); lastClimbSent = -Infinity; }
      if (at - lastRoundSent >= ROUND_SEND_MS) { sentQ = Math.max(Date.now(), sentQ + 1); wire.broadcast(JSON.stringify(roundFrame(round, at, sentQ))); lastRoundSent = at; }
      if (climb && at - lastClimbSent >= CLIMB_SEND_MS) { sentQ = Math.max(Date.now(), sentQ + 1); wire.broadcast(JSON.stringify(climbFrame(climb, round.n, at, sentQ))); lastClimbSent = at; }
    }
    wasLeader = leading;
    // My seat, as the climb goes.
    if (seated()) {
      if (!settled()) seat = earn(seat, dt);
      if (climb) {
        const was = seat;
        seat = follow(seat, climb, at - climb.t0);
        if (seat.gilded > was.gilded && seat.c === was.c) tell({ kind: 'gilded', who: me, amount: seat.gilded - was.gilded }, at);
        if (seat.interest > 0 && was.interest < 0 && seat.c === was.c) tell({ kind: 'interest', amount: seat.interest }, at);
        if (was.at === RIDING && seat.at >= 0) tell({ kind: 'grab', who: me, won: seat.won, h: seat.at }, at);
        const left = Math.ceil((climb.bet - (at - climb.t0)) / 1000);
        if (left !== lastBeep && left >= 1 && left <= 3) { lastBeep = left; tell({ kind: 'beep' }, at); }
      }
    }
    if (round.phase === 'count' && !watching()) {
      const left = Math.ceil((COUNT_MS - (at - round.since)) / 1000);
      if (left !== lastBeep && left >= 1 && left <= 3) { lastBeep = left; tell({ kind: 'beep' }, at); }
    }
    if (at - lastSeatSent >= SEND_MS) {
      wire.broadcast(JSON.stringify(seatFrame(seat, watching() ? 0 : playing, round.n, climb?.c ?? 0, may)));
      lastSeatSent = at;
    }
    happened = happened.filter((h) => at - h.at <= STALE_MS);
  }

  /** Whether a grab now is one: on the tower, the stakes closed, and the next coin not yet due, by my clock. */
  const canGrab = (at: number): boolean => {
    if (!seated() || !climb || seat.at !== RIDING || seat.c !== climb.c || climb.fell >= 0) return false;
    const ms = at - climb.t0;
    return ms >= climb.bet && ms < climb.next;
  };

  return {
    step,
    canGrab,
    /** Whether a double or nothing now is one. */
    canFlip: (at: number): boolean => seated() && canFlip(seat) && !lateForDouble(at),
    grab(at: number): void { if (canGrab(at)) { seat = grab(seat, climb!.h); tell({ kind: 'grab', who: me, won: seat.won, h: seat.at }, at); lastSeatSent = -Infinity; } },
    flip(roll: number, at: number): void {
      if (!seated() || !canFlip(seat) || lateForDouble(at)) return;
      const amount = flipStake(seat);
      seat = flip(seat, roll);
      tell({ kind: 'flip', who: me, win: seat.flip === 1, amount }, at);
      lastSeatSent = -Infinity;
    },
    share(s: Share): void { seat = { ...seat, share: s }; },
    buy(u: Upgrade): boolean { if (!seated()) return false; const next = buy(seat, u); if (next === seat) return false; seat = next; lastSeatSent = -Infinity; return true; },
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
