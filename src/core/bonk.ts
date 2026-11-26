// Bonk, the first game (core/game.ts): every player is a ball with their face on it, on an ice floe in the sea. Roll,
// dash, bonk the others off; the floe shrinks while a round goes on, and the last one on it wins the round, or the last
// ones share it, fallen together (TIE_MS). Who fell off blows a wind across the floe now and then (`Gust`). Now and then
// a mystery ball falls in the middle, and whoever bonked it last when it goes off gets what is in it: a giga, its next
// bonk many times as hard (`gigaPower`), or heavy, handling or double speed for the rest of the round (`Item`).
//
// Every app moves its own ball and nobody else's, and sends where it is to every other player many times a second
// (`BallFrame`); the app whose ball runs into another works the bonk out and gives the other ball its knock (`HitFrame`).
// The rounds are the leader's, as in every game (core/rounds.ts); what ends one here is the floe. The items are the
// leader's too (`Stage`), and so is the mystery ball: its app moves it, and the others send it their bonks (`PushFrame`).
// Runtime-neutral: plain data only.
import { firstRound, frameFields, isWho, leaderOf, num, parseRoundFrame, round2, roundFrame, roundOf, whoOf, MAX_PLAYERS, WHO_LENGTH, type Phase, type Round, type RoundFrame } from './rounds';
// The rounds are every game's (core/rounds.ts); Bonk's are said here too, as they were before there were two games.
export { firstRound, leaderOf, roundFrame, roundOf, whoOf, MAX_PLAYERS, WHO_LENGTH, type Phase, type Round, type RoundFrame };

/** A ball's radius, and the floe's at the start of a round and where it stops shrinking, in the game's units. */
export const BALL_RADIUS = 0.85;
export const FLOE_START = 9;
export const FLOE_MID = 3.2;
/** How hard a player rolls their ball (units/s²), and the fastest they roll it by themselves. */
export const ACCEL = 15;
export const MAX_ROLL = 7.5;
/** How quickly a ball slows by itself, per second: ice, so slowly. */
export const DRAG = 0.9;
/** A dash: this fast, at once, then not again for a while. */
export const DASH_SPEED = 15;
export const DASH_COOLDOWN_MS = 1400;
/** How much a bonk gives back: more than it took, so a bonk sends a ball flying. */
export const BOUNCE = 1.35;
export const GRAVITY = 24;
/** How far a ball falls before it is gone. */
export const SUNK_Y = -8;
/** How long a ball that fell off waits before it comes back, between rounds. */
export const RESPAWN_MS = 1200;

/** How long the countdown before a round lasts, and how long the winner is shown after it. */
export const COUNT_MS = 3000;
export const OVER_MS = 4000;
/**
 * How soon after the last but one the last ball must fall to share the round with it: a photo finish. The leader hears of
 * a fall from each ball's own app, a frame and a link later, so who fell first by less than this is as much the links'
 * doing as the players'.
 */
export const TIE_MS = 500;
/** While a round plays: the floe stays whole for a moment, shrinks to FLOE_MID, then on to nothing, so every round ends. */
export const SHRINK_FROM_MS = 5000;
export const SHRINK_MID_MS = 45_000;
export const SHRINK_END_MS = 65_000;

/** The floe's radius, `ms` into a phase; after a round, as it was when the round ended (`ended`). */
export function floeRadius(phase: Phase, ms: number, ended = FLOE_START): number {
  if (phase !== 'play') return phase === 'over' ? ended : FLOE_START;
  if (ms <= SHRINK_FROM_MS) return FLOE_START;
  if (ms <= SHRINK_MID_MS) return FLOE_START + ((FLOE_MID - FLOE_START) * (ms - SHRINK_FROM_MS)) / (SHRINK_MID_MS - SHRINK_FROM_MS);
  return Math.max(0, FLOE_MID * (1 - (ms - SHRINK_MID_MS) / (SHRINK_END_MS - SHRINK_MID_MS)));
}

/** A ball as its player's app moves it. `y` is its height: 0 on the floe, below once it fell off. */
export type Ball = {
  x: number; z: number; vx: number; vz: number;
  y: number; vy: number;
  /** On the floe, and in the round (or rolling around between rounds). */
  alive: boolean;
  /** When it last dashed, by its app's clock (ms); -Infinity for never. */
  dashAt: number;
};

export const ballAt = (x: number, z: number): Ball => ({ x, z, vx: 0, vz: 0, y: 0, vy: 0, alive: true, dashAt: -Infinity });

/** Another player's ball as this app last heard of it; `y`, how high it is, for one up in the air. */
export type Seen = { x: number; z: number; vx: number; vz: number; alive: boolean; y?: number };

/** Where a round puts the `i`th of `count` players: evenly round a ring, facing in. */
export function spawnAt(i: number, count: number): { x: number; z: number } {
  if (count <= 1) return { x: 0, z: 0 };
  const a = (2 * Math.PI * i) / count - Math.PI / 2;
  const r = FLOE_START * 0.6;
  return { x: Math.round(r * Math.cos(a) * 1000) / 1000, z: Math.round(r * Math.sin(a) * 1000) / 1000 };
}

/** The direction a player steers in, of at most length 1: keys give one of eight, a stick anything in between. */
export function steer(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z);
  return l > 1 ? { x: x / l, z: z / l } : { x, z };
}

/**
 * Steering toward a spot on the floe the mouse is held on: for the speed that gets there, full on from afar
 * and slower the nearer it is, so the ball brakes and stops there instead of sliding past and swinging round it, as it
 * would on ice. `ball` is where it is and how fast it goes.
 */
export function toward(ball: { x: number; z: number; vx: number; vz: number }, to: { x: number; z: number }): { x: number; z: number } {
  const dx = to.x - ball.x, dz = to.z - ball.z;
  const d = Math.hypot(dx, dz);
  const want = d < 1e-6 ? 0 : Math.min(MAX_ROLL, d * 2.5) / d;
  return steer((dx * want - ball.vx) / 3, (dz * want - ball.vz) / 3);
}

/** Whether a ball can dash at `now`: on the floe, not up in the air. */
export const canDash = (b: Ball, now: number): boolean => b.alive && b.y <= 0 && b.vy <= 0 && now - b.dashAt >= DASH_COOLDOWN_MS;

/**
 * A dash at `now`: off at DASH_SPEED in the direction steered, or straight on without one; nothing while it cannot. A
 * ball standing still with nothing steered stays put.
 */
export function dash(b: Ball, dir: { x: number; z: number }, now: number): Ball {
  if (!canDash(b, now)) return b;
  let dx = dir.x, dz = dir.z;
  if (Math.hypot(dx, dz) < 0.1) { dx = b.vx; dz = b.vz; }
  const l = Math.hypot(dx, dz);
  if (l < 0.1) return b;
  return { ...b, vx: (dx / l) * Math.max(DASH_SPEED, Math.hypot(b.vx, b.vz)), vz: (dz / l) * Math.max(DASH_SPEED, Math.hypot(b.vx, b.vz)), dashAt: now };
}

/**
 * How a ball moves and how much it weighs, by what it got this round (`movesOf`): its mass in a bonk, how hard it rolls
 * itself (ACCEL), how fast (MAX_ROLL), and how quickly the ice slows it (DRAG).
 */
export type Moves = { mass: number; accel: number; top: number; drag: number };
export const PLAIN: Moves = { mass: 1, accel: ACCEL, top: MAX_ROLL, drag: DRAG };

// Wind.

/**
 * A wind a player who fell off blew (`GustFrame`), the way they chose, of length 1: it pushes every ball on the floe that
 * way for GUST_MS, until `until` by the app's own clock that felt it. Gusts blown at once add up.
 */
export type Gust = { x: number; z: number; until: number };
/** How often a player who fell off may blow, how long a gust lasts, and how hard it pushes (units/s²; a player rolls ACCEL). */
export const GUST_EVERY_MS = 10_000;
export const GUST_MS = 1500;
export const GUST_ACCEL = 8;
export const STILL = { x: 0, z: 0 };

/** The gust a player blows at `now` the way `dir` points (any length), or null for no way at all. */
export function gust(dir: { x: number; z: number }, now: number): Gust | null {
  const l = Math.hypot(dir.x, dir.z);
  return l < 0.1 ? null : { x: dir.x / l, z: dir.z / l, until: now + GUST_MS };
}

/** The wind on the floe at `now`: every gust still blowing, added up (units/s²). */
export const windAt = (gusts: readonly Gust[], now: number): { x: number; z: number } =>
  gusts.reduce((w, g) => (g.until > now ? { x: w.x + g.x * GUST_ACCEL, z: w.z + g.z * GUST_ACCEL } : w), STILL);

/** Whether a player who fell off, who last blew at `last` (-Infinity for not this round), may blow again at `now`. */
export const canBlow = (last: number, now: number): boolean => now - last >= GUST_EVERY_MS;

/**
 * The ball `dt` seconds on: rolled the way it is steered (to its top speed, `moves`; faster only by a dash, a bonk or the
 * wind, `windAt`, which then slow by themselves), slowed by the ice. Off the floe (`floe`, its radius) it falls, and is out. Thrown up
 * by a giga (`giga`), or dropped from the sky, it flies, steered by nobody, and comes down on the floe; out over the sea,
 * it is out.
 */
export function roll(b: Ball, dir: { x: number; z: number }, dt: number, floe: number, moves: Moves = PLAIN, wind: { x: number; z: number } = STILL): Ball {
  if (!b.alive) {
    if (b.y <= SUNK_Y) return b;
    const vy = b.vy - GRAVITY * dt;
    return { ...b, x: b.x + b.vx * dt, z: b.z + b.vz * dt, vx: b.vx * 0.98, vz: b.vz * 0.98, vy, y: Math.max(SUNK_Y, b.y + vy * dt) };
  }
  if (b.y > 0 || b.vy > 0) {
    const vy = b.vy - GRAVITY * dt;
    const slow = Math.exp(-AIR_DRAG * dt);
    const x = b.x + b.vx * dt, z = b.z + b.vz * dt, y = b.y + vy * dt;
    // Out over the sea it cannot come back, steered by nobody: out at once, not when it comes down, so the one who
    // threw it does not lose the round to a ball still in the air.
    if (!(Math.hypot(x, z) <= floe)) return { ...b, x, z, y, vy, alive: false };
    if (y > 0) return { ...b, x, z, y, vy, vx: b.vx * slow, vz: b.vz * slow };
    return { ...b, x, z, y: 0, vy: 0 };
  }
  const was = Math.hypot(b.vx, b.vz);
  let vx = b.vx + dir.x * moves.accel * dt;
  let vz = b.vz + dir.z * moves.accel * dt;
  const speed = Math.hypot(vx, vz);
  const cap = Math.max(was, moves.top);
  if (speed > cap) { vx = (vx / speed) * cap; vz = (vz / speed) * cap; }
  // The wind past the cap: it blows a ball on faster than it rolls itself.
  vx += wind.x * dt; vz += wind.z * dt;
  const slow = Math.exp(-moves.drag * dt);
  vx *= slow; vz *= slow;
  const x = b.x + vx * dt, z = b.z + vz * dt;
  // Off once its middle is past the edge: half of it hangs over the water, and over it goes.
  if (!(Math.hypot(x, z) <= floe)) return { ...b, x, z, vx, vz, alive: false, vy: 0 };
  return { ...b, x, z, vx, vz };
}

/** A bonk at least this hard (`bonk`, `hit`) is felt: it shows, counts toward the next item, and spends a giga. */
export const FELT_HIT = 0.5;
/** The least a giga multiplies a bonk by, and the most a frame may say, which no draw comes near (`gigaPower`). */
export const GIGA_LOW = 2;
export const GIGA_MOST = 1e6;
/**
 * How rare a harder giga is: the chance of one at least `p` times as hard is (GIGA_LOW / p) ^ GIGA_TAIL. Half are under
 * 3.2 times, one in 11 is 10 times or more, one in 350 is 100 times or more, and there is no top.
 */
export const GIGA_TAIL = 1.5;
/**
 * The most a giga bonk changes a ball's speed by along the floe: a hundred times a real bonk would have it out of sight
 * before anyone saw it go. What it would have been past that goes up into the air instead (`giga`).
 */
export const GIGA_TOP = 60;
/** How hard a giga throws a ball up: LIFT for every time e that it is past LIFT_FROM, to SKY_TOP (units/s). */
const LIFT = 6;
const LIFT_FROM = 8;
export const SKY_TOP = 80;
/** How quickly a ball in the air slows along the floe, per second: more than on the ice, so it lands in sight. */
export const AIR_DRAG = 1.5;

/** How many times as hard a giga bonk is (GIGA_TAIL): GIGA_LOW or more, to two places. `random` in [0, 1). */
export const gigaPower = (random: number): number => Math.min(GIGA_MOST, Math.round(GIGA_LOW * (1 - random) ** (-1 / GIGA_TAIL) * 100) / 100);

/**
 * How mighty a giga is, for how it looks: 0 under 3 times, 1 from 3, 2 from 5, 3 from 10, 4 from 25, and 5 from 100,
 * the rarest; -1 for none.
 * Of every thousand gigas, some 454 are 0, 292 are 1, 164 are 2, 67 are 3, 20 are 4, and 3 are 5.
 */
export const GIGA_TIERS = [GIGA_LOW, 3, 5, 10, 25, 100] as const;
export const gigaTier = (power: number): number => GIGA_TIERS.findLastIndex((from) => power >= from);

/**
 * A giga's change in a ball's speed: along the line between the two balls, `power` times as big (0 for none), to
 * GIGA_TOP; and, past LIFT_FROM, up into the air (`up`), more the harder it is.
 */
export function giga(along: number, power: number): { along: number; up: number } {
  if (power <= 1) return { along, up: 0 };
  const speed = Math.abs(along) * power;
  return { along: Math.sign(along) * Math.min(speed, Math.max(Math.abs(along), GIGA_TOP)), up: Math.min(SKY_TOP, Math.max(0, LIFT * Math.log(speed / LIFT_FROM))) };
}

/** A knock (`bonk`): the change in a ball's speed along the floe, and how fast it goes up (a giga's, else 0). */
export type Knock = { vx: number; vz: number; up: number };

/**
 * My ball after it met `other`: pushed out of it, and, while the two come at each other, given the other's speed along
 * the line between them, and more (BOUNCE). `knock` is what the other ball gets of the same bonk, the change in its
 * speed, which only its own app can give it (`HitFrame`): by the time the other app hears where my ball is, mine has
 * bounced off already, and it would see the two touch, never meet. Returns how hard they met too (0 for not at all),
 * for the sound and the shake. A ball up in the air meets none.
 *
 * `mine` and `theirs` are the two balls' giga (`gigaPower`, 0 for none): a felt bonk (FELT_HIT) makes my giga's knock
 * that much harder (`giga`), and theirs my own change, and spends them (`spent`, 0 for a giga not spent). Each app
 * knows another's giga from its last frame, so in a pile-up, two bonks a moment apart, one giga may land on both.
 * `myMass` and `theirMass` (`Moves`): the heavier ball is the harder to move.
 */
export function bonk(me: Ball, other: Seen, mine = 0, theirs = 0, myMass = 1, theirMass = 1): { ball: Ball; hit: number; knock: Knock; spent: { mine: number; theirs: number } } {
  const none = { vx: 0, vz: 0, up: 0 };
  const unspent = { mine: 0, theirs: 0 };
  if (!me.alive || !other.alive || me.y > BALL_RADIUS || (other.y ?? 0) > BALL_RADIUS) return { ball: me, hit: 0, knock: none, spent: unspent };
  const dx = other.x - me.x, dz = other.z - me.z;
  const d = Math.hypot(dx, dz);
  if (d >= 2 * BALL_RADIUS) return { ball: me, hit: 0, knock: none, spent: unspent };
  // Right on top of each other, which hardly happens: apart along x.
  const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
  const push = (2 * BALL_RADIUS - d) / 2;
  const x = me.x - nx * push, z = me.z - nz * push;
  const mineAlong = me.vx * nx + me.vz * nz;
  const theirsAlong = other.vx * nx + other.vz * nz;
  // Moving apart already: only pushed out.
  if (mineAlong - theirsAlong <= 0) return { ball: { ...me, x, z }, hit: 0, knock: none, spent: unspent };
  // They come apart BOUNCE times as fast as they met: what one loses the other gets, shared out by mass (of two equal
  // masses, mine along the line becomes theirs and theirs mine, and more).
  const hit = mineAlong - theirsAlong;
  const shove = ((1 + BOUNCE) * hit) / (1 / myMass + 1 / theirMass);
  const spent = hit >= FELT_HIT ? { mine, theirs } : unspent;
  const change = giga(-shove / myMass, spent.theirs);
  const knock = giga(shove / theirMass, spent.mine);
  const ball = { ...me, x, z, vx: me.vx + change.along * nx, vz: me.vz + change.along * nz, vy: Math.max(me.vy, change.up) };
  return { ball, hit, knock: { vx: knock.along * nx, vz: knock.along * nz, up: knock.up }, spent };
}

/** A bonk another player's app worked out, given to my ball: `knock`, the change in its speed (`bonk`). */
export const knocked = (b: Ball, knock: { vx: number; vz: number; up?: number }): Ball =>
  (b.alive ? { ...b, vx: b.vx + knock.vx, vz: b.vz + knock.vz, vy: Math.max(b.vy, knock.up ?? 0) } : b);

// Items.

/**
 * What a mystery ball holds: a giga (`gigaPower`) for the next bonk, or for the rest of the round heavy (hard to move,
 * and slow), handling (quick to turn and to stop) or double speed, for everyone and the floe too.
 */
export type Item = 'giga' | 'heavy' | 'handling' | 'fast';
export const ITEMS: readonly Item[] = ['giga', 'heavy', 'handling', 'fast'];
/** Roughly every ITEM_EVERY felt bonks in a game, a mystery ball falls (`dropIn`); and one for every DROP_WINS wins. */
export const ITEM_EVERY = 100;
export const DROP_WINS = 10;
/** How high a mystery ball falls from, into the middle of the floe. */
export const DROP_Y = 14;
/** Heavy: so many times the mass, rolled so much less hard and fast. */
export const HEAVY_MASS = 3;
const HEAVY_ACCEL = 0.6;
const HEAVY_TOP = 0.75;
/** Handling: rolled so much harder, a little faster, and slowed by the ice this much more quickly (DRAG). */
const HANDLING_ACCEL = 2.2;
const HANDLING_TOP = 1.15;
const HANDLING_DRAG = 2;
/** Double speed: everything goes this many times as fast, the floe's shrinking too. */
export const FAST = 2;

/** How many felt bonks until the next mystery ball: 1 to 2 × ITEM_EVERY − 1, all as likely, so ITEM_EVERY on average. `random` in [0, 1). */
export const dropIn = (random: number): number => 1 + Math.floor(random * (2 * ITEM_EVERY - 1));
/** What a mystery ball holds, all four as likely. `random` in [0, 1). */
export const itemOf = (random: number): Item => ITEMS[Math.min(ITEMS.length - 1, Math.floor(random * ITEMS.length))]!;
/** How many mystery balls a player may still drop: one for every DROP_WINS wins, less those dropped. */
export const dropsLeft = (wins: number, used: number): number => Math.max(0, Math.floor(wins / DROP_WINS) - used);

/** An item a player got: its mystery ball's `id`, who got it, what, a giga's power (0 for another), and when (`t`, ms into the round's play). */
export type Got = { id: number; who: string; item: Item; power: number; t: number };

/**
 * Bonk's items, as the leader keeps them beside the round and sends them with it (`StageFrame`), so another leader goes
 * on from them: for round `n`, the mystery balls each player has dropped of those their wins earned (`used`), who dropped
 * one this round (`asked`) and whether it has yet to fall (`waiting`), what was got, and the mystery ball on the floe
 * (`ball`, its id; 0 for none) with who bonked it last (`by`). `ids` is the last id given; `bonks`, the felt bonks
 * counted since the last mystery ball fell by itself, each twice, once by each ball's app, toward the next (`next`,
 * `dropIn`).
 */
export type Stage = {
  n: number; used: Record<string, number>; asked: string | null; waiting: boolean; got: Got[]; ball: number; by: string | null; ids: number;
  bonks: number; next: number;
};

export const firstStage = (next = ITEM_EVERY): Stage => ({ n: 0, used: {}, asked: null, waiting: false, got: [], ball: 0, by: null, ids: 0, bonks: 0, next });

/**
 * The stage for round `n`: a new round starts with nothing got, no ball and no drop asked for. A drop asked for that
 * never fell (the round went back to waiting for a friend) is given back.
 */
export function stageOf(s: Stage, n: number): Stage {
  if (s.n === n) return s;
  const used = s.asked !== null && s.waiting ? { ...s.used, [s.asked]: Math.max(0, (s.used[s.asked] ?? 0) - 1) } : s.used;
  return { ...s, n, used, asked: null, waiting: false, got: [], ball: 0, by: null };
}

/** The felt bonks of the game come to the next draw: a mystery ball falls by itself (`dropped`). */
export const dropDue = (s: Stage): boolean => s.bonks / 2 >= s.next;

/** How long into a round's play a mystery ball may still be dropped: its start, as the floe stays whole. */
export const DROP_PLAY_MS = SHRINK_FROM_MS;
/** Whether a round is at its start at `now`, for a drop: counting down, or the first of its play (DROP_PLAY_MS). */
export const dropTime = (r: Round, now: number): boolean => r.phase === 'count' || (r.phase === 'play' && now - r.since < DROP_PLAY_MS);

/**
 * A player asks to drop a mystery ball in round `r` at `now`: taken at its start (`dropTime`), if their wins earned one,
 * one a round, and none while another is on the floe.
 */
export function ask(s: Stage, r: Round, who: string, now: number): Stage {
  const used = s.used[who] ?? 0;
  if (!dropTime(r, now) || s.n !== r.n || s.asked !== null || s.ball !== 0 || dropsLeft(r.wins[who] ?? 0, used) === 0) return s;
  return { ...s, asked: who, waiting: true, used: { ...s.used, [who]: used + 1 } };
}

/**
 * A mystery ball falls in: a new id, bonked by nobody yet. The drop asked for, if one waits, is the one; else it fell by
 * itself, and the count starts over to a new draw (`next`, `dropIn`).
 */
export const dropped = (s: Stage, next: number): Stage =>
  ({ ...s, ball: s.ids + 1, ids: s.ids + 1, by: null, ...(s.waiting ? { waiting: false } : { bonks: 0, next }) });

/** Mystery ball `id` bonked by `who`. */
export const touched = (s: Stage, id: number, who: string): Stage => (s.ball === id && id !== 0 ? { ...s, by: who } : s);

/**
 * The mystery ball off the floe, `t` ms into the play: what is in it goes to who bonked it last, if anybody did. `item`
 * and `power` drawn by the leader (`itemOf`, `gigaPower`).
 */
export function gone(s: Stage, t: number, item: Item, power: number): Stage {
  if (s.ball === 0) return s;
  const got = s.by === null ? s.got : [...s.got, { id: s.ball, who: s.by, item, power: item === 'giga' ? power : 0, t: Math.max(0, Math.round(t)) }];
  return { ...s, ball: 0, by: null, got };
}

/** What a player got this round that lasts it: heavy, handling. */
export type Effects = { heavy: boolean; handling: boolean };
export const effectsOf = (s: Stage, who: string): Effects =>
  ({ heavy: s.got.some((g) => g.who === who && g.item === 'heavy'), handling: s.got.some((g) => g.who === who && g.item === 'handling') });

/** How a ball with `e` moves (`Moves`). */
export const movesOf = (e: Effects): Moves => ({
  mass: e.heavy ? HEAVY_MASS : 1,
  accel: ACCEL * (e.heavy ? HEAVY_ACCEL : 1) * (e.handling ? HANDLING_ACCEL : 1),
  top: MAX_ROLL * (e.heavy ? HEAVY_TOP : 1) * (e.handling ? HANDLING_TOP : 1),
  drag: e.handling ? HANDLING_DRAG : DRAG,
});

/** When double speed began, ms into the round's play; null for not this round. */
export const fastFrom = (s: Stage): number | null => s.got.reduce<number | null>((at, g) => (g.item === 'fast' && (at === null || g.t < at) ? g.t : at), null);
/** How many times as fast the game goes `ms` into the play. */
export const speedAt = (ms: number, fast: number | null): number => (fast !== null && ms >= fast ? FAST : 1);
/** How far on the round's play is `ms` into it, for the floe: double speed's time counts double. */
export const playClock = (ms: number, fast: number | null): number => (fast === null || ms <= fast ? ms : fast + (ms - fast) * FAST);

/**
 * How long after a bonk between two balls another between the same two is not taken: both apps may work out the same
 * bonk, each from where it sees the other, and send it; the first one taken counts.
 */
export const BONK_AGAIN_MS = 250;

/**
 * Where another player's ball is `ageMs` after this app last heard of it: on as it was going, for a quarter of a second
 * at most. Unheard of for longer, it waits where it was.
 */
export const ahead = (s: Seen, ageMs: number): Seen => {
  const t = Math.min(Math.max(0, ageMs), 250) / 1000;
  return { ...s, x: s.x + s.vx * t, z: s.z + s.vz * t };
};

// The rounds.

/**
 * A player as the leader counts them: by the start of their key, the round they play (`n`, 0 for none: they watch), the
 * newest round they know (`known`), and whether they are on the floe.
 */
export type Counted = { who: string; n: number; known: number; alive: boolean };

/** What the inspection hooks show of the game (`window.__daveGame`, client/bonk.ts). */
export type GameView = {
  phase: Phase; round: number; leader: string | null; playing: boolean; spectating: boolean; webgl: boolean; winner: string | null; tied: string[];
  /**
   * `wind`: what blows on my ball now (`windAt`); `blow`: ms until I may blow one, 0 for now, -1 for not at all (I am not
   * out); `way`: which way I would blow it, of length 1, null while I am not out.
   */
  me: {
    x: number; z: number; vx: number; vz: number; alive: boolean; lastDash: { vx: number; vz: number } | null; giga: number; heavy: boolean; handling: boolean; drops: number;
    wind: { x: number; z: number }; blow: number; way: { x: number; z: number } | null;
  };
  item: { x: number; z: number; y: number; vx: number; vz: number; alive: boolean } | null; got: { who: string; item: Item }[]; fast: boolean;
  aim: { x: number; z: number } | null; others: { key: string; x: number; z: number; alive: boolean; giga: number }[]; wins: Record<string, number>; connected: number;
};

/**
 * The round as its leader runs it: what the leader's app keeps of the play besides, for a tie, which goes to nobody else
 * (a new leader decides without it). `standing`: who stood on the floe, as last counted while more than one did.
 * `closing`: when one or none was left, and who stood until then, who share the round if the last (`last`, for one left)
 * falls within TIE_MS.
 */
export type Led = Round & { standing?: string[]; closing?: { at: number; who: string[]; last?: string } };

/**
 * The round at `now`, with `here` the players the leader hears from (the leader too). A second player starts a round;
 * the countdown runs to the play, and starts over with everyone when who is here changes; the play runs until one player
 * or none is left on the floe, and TIE_MS on for one; the winner is shown, or those who tied, and the next round starts,
 * or the wait if only one player is left. A player who came in after the countdown watches. `tieMs`: TIE_MS, but for the
 * suite's pages, which draw in software, a frame in up to half a second.
 */
export function advance(r: Led, now: number, here: readonly Counted[], tieMs = TIE_MS): Led {
  const ms = now - r.since;
  const enough = here.length >= 2;
  const count = (n: number): Led => ({ n, phase: 'count', since: now, players: here.map((p) => p.who).sort(), winner: null, wins: r.wins });
  switch (r.phase) {
    case 'wait':
      return enough ? count(r.n + 1) : r;
    case 'count': {
      if (!enough) return { ...r, phase: 'wait', since: now, players: [] };
      // Who is here changed while it counts down: a friend linked or went, or two apps each counted the round down with
      // some of the players, and one now leads them all. Counted down again, with everyone in.
      if (!same(here.map((p) => p.who).sort(), r.players)) return count(r.n);
      return ms >= COUNT_MS ? { ...r, phase: 'play', since: now } : r;
    }
    case 'play': {
      // Gone from the game counts as fallen, and so does one who came back and only watches (a reload); one whose app
      // has not yet taken the round stands on it still.
      const standing = r.players.filter((who) => { const p = here.find((h) => h.who === who); return p !== undefined && (p.known < r.n || (p.n === r.n && p.alive)); });
      if (standing.length > 1) return r.closing === undefined && same(standing, r.standing) ? r : { ...settled(r), standing };
      // One left, or none: those who stood until then share the round if the last one falls too, within TIE_MS. A leader
      // that never counted more than the one standing (it took over just now) has nobody to wait for.
      const closing = r.closing ?? { at: now, who: r.standing ?? standing, ...(standing.length === 1 ? { last: standing[0] } : {}) };
      const late = now - closing.at >= tieMs;
      if (standing.length === 1 && closing.who.length > 1 && !late) return r.closing ? r : { ...r, closing };
      // None left, counted only after TIE_MS (a leader whose tab is hidden counts once a second): the last one stood it out.
      const winner = standing[0] ?? (late ? closing.last ?? null : null);
      const tied = winner === null && closing.who.length > 1 ? closing.who : [];
      const wins = { ...r.wins };
      for (const who of winner ? [winner] : tied) wins[who] = (wins[who] ?? 0) + 1;
      return { ...settled(r), phase: 'over', since: now, winner, wins, ...(tied.length ? { tied } : {}) };
    }
    case 'over':
      if (ms < OVER_MS) return r;
      return enough ? count(r.n + 1) : { ...settled(r), phase: 'wait', since: now, players: [], winner: null };
  }
}

/** The round alone, without what its leader keeps of the play (`Led`), nor a tie of the round before. */
const settled = (r: Led): Round => ({ n: r.n, phase: r.phase, since: r.since, players: r.players, winner: r.winner, wins: r.wins });
const same = (a: readonly string[], b: readonly string[] | undefined): boolean => b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

// On the wire: as core/rounds.ts says.

/**
 * Where a player's ball is, from that player: `r` the round they play (0 for none: they watch), `n` the newest round
 * they know (core `leaderOf`). `a`: on the floe (or up over it); `d`: dashed just now; `g`: its giga (`gigaPower`), left
 * out for none, as apps from before giga send it; `c`: the felt bonks it had in the game, which the leader counts
 * toward the next mystery ball (`dropIn`), left out by apps from before items.
 */
export type BallFrame = { k: 'b'; r: number; n: number; x: number; z: number; vx: number; vz: number; y: number; a: boolean; d: boolean; g?: number; c?: number };
/**
 * A bonk my app worked out, for the ball of `to` (the start of its key): the change in its speed (`bonk`, `knock`), with
 * `up` how fast a giga throws it up. `g`: my giga, spent on it; `u`: theirs, spent on my own ball's change, so their app
 * knows it is gone (`bonk`, `spent`). Each left out for none.
 */
export type HitFrame = { k: 'h'; to: string; vx: number; vz: number; hit: number; up?: number; g?: number; u?: number };
/** The round with Bonk's items (`Stage`, of the round's `n`), from the leader; `st` is left out by apps from before items. */
export type StageFrame = RoundFrame & { st?: StageWire };
/**
 * A stage on the wire: `u` used, `a` asked, `w` waiting, `g` got (`id`, `who`, `item`, `power`, `t`), `b` ball, `by`,
 * `i` ids, `f` bonks, `nx` next.
 */
export type StageWire = { u: [string, number][]; a: string | null; w: boolean; g: [number, string, Item, number, number][]; b: number; by: string | null; i: number; f: number; nx: number };
/** The mystery ball `id`, where the leader's app has it, as a ball's frame says (`a`: on the floe or over it). */
export type ItemFrame = { k: 'i'; id: number; x: number; z: number; vx: number; vz: number; y: number; vy: number; a: boolean };
/** A bonk my app worked out between my ball and mystery ball `id`, for the leader: the ball's knock (`bonk`, `knock`). */
export type PushFrame = { k: 'p'; id: number; vx: number; vz: number; up: number };
/** For the leader: I drop a mystery ball in round `n` (`ask`). */
export type DropFrame = { k: 'd'; n: number };
/** For everyone: I fell off in round `n`, and blow a wind the way `x`, `z` point (`gust`), of length 1. */
export type GustFrame = { k: 'w'; n: number; x: number; z: number };
export type Frame = BallFrame | StageFrame | HitFrame | ItemFrame | PushFrame | DropFrame | GustFrame;

export const ballFrame = (b: Ball, r: number, n: number, dashed: boolean, giga = 0, felt = 0): BallFrame =>
  ({ k: 'b', r, n, x: round2(b.x), z: round2(b.z), vx: round2(b.vx), vz: round2(b.vz), y: round2(b.y), a: b.alive, d: dashed, ...(giga ? { g: giga } : {}), ...(felt ? { c: felt } : {}) });

export const stageFrame = (r: Round, s: Stage, now: number, q: number): StageFrame => ({
  ...roundFrame(r, now, q),
  st: {
    u: Object.entries(s.used), a: s.asked, w: s.waiting, g: s.got.map((g) => [g.id, g.who, g.item, g.power, g.t]), b: s.ball, by: s.by, i: s.ids,
    f: s.bonks, nx: s.next,
  },
});
/** The stage a follower takes from the leader's frame. */
export const stageOfFrame = (f: StageFrame): Stage | null => (f.st
  ? {
    n: f.n, used: Object.fromEntries(f.st.u), asked: f.st.a, waiting: f.st.w, got: f.st.g.map(([id, who, item, power, t]) => ({ id, who, item, power, t })),
    ball: f.st.b, by: f.st.by, ids: f.st.i, bonks: f.st.f, next: f.st.nx,
  }
  : null);

export const itemFrame = (id: number, b: Ball): ItemFrame =>
  ({ k: 'i', id, x: round2(b.x), z: round2(b.z), vx: round2(b.vx), vz: round2(b.vz), y: round2(b.y), vy: round2(b.vy), a: b.alive });

export const gustFrame = (n: number, g: Gust): GustFrame => ({ k: 'w', n, x: round2(g.x), z: round2(g.z) });

export const pushFrame = (id: number, knock: Knock): PushFrame => ({ k: 'p', id, vx: round2(knock.vx), vz: round2(knock.vz), up: round2(knock.up) });

export const hitFrame = (to: string, knock: Knock, hit: number, spent = { mine: 0, theirs: 0 }): HitFrame => ({
  k: 'h', to: whoOf(to), vx: round2(knock.vx), vz: round2(knock.vz), hit: round2(hit),
  ...(knock.up > 0 ? { up: round2(knock.up) } : {}), ...(spent.mine ? { g: spent.mine } : {}), ...(spent.theirs ? { u: spent.theirs } : {}),
});

/**
 * A giga as a frame says it, or undefined for none; one out of range is taken as none, not the frame thrown away, so a
 * later app that gigas otherwise still moves its ball for this one.
 */
const gigaOf = (v: unknown): number | undefined => (num(v, GIGA_MOST) && v >= GIGA_LOW ? v : undefined);

/** A frame from another player, or null for anything off. */
export function parseFrame(text: unknown): Frame | null {
  const f = frameFields(text);
  if (!f) return null;
  if (f['k'] === 'b') {
    const { r, n, x, z, vx, vz, y, a, d } = f;
    if (!Number.isSafeInteger(r) || (r as number) < 0 || !Number.isSafeInteger(n) || (n as number) < 0 || !num(x) || !num(z) || !num(vx) || !num(vz) || !num(y) || typeof a !== 'boolean' || typeof d !== 'boolean') return null;
    const g = gigaOf(f['g']);
    const c = Number.isSafeInteger(f['c']) && (f['c'] as number) > 0 ? (f['c'] as number) : undefined;
    return { k: 'b', r: r as number, n: n as number, x, z, vx, vz, y, a, d, ...(g !== undefined ? { g } : {}), ...(c !== undefined ? { c } : {}) };
  }
  if (f['k'] === 'h') {
    const { to, vx, vz, hit } = f;
    if (!isWho(to) || !num(vx, 100) || !num(vz, 100) || !num(hit, 100) || (hit as number) < 0) return null;
    // The giga's fields, each taken as none when off (`gigaOf`); a throw up as far as SKY_TOP.
    const g = gigaOf(f['g']), u = gigaOf(f['u']), up = num(f['up'], 1e6) && f['up'] > 0 ? Math.min(SKY_TOP, f['up']) : undefined;
    return { k: 'h', to, vx, vz, hit: hit as number, ...(up !== undefined ? { up } : {}), ...(g !== undefined ? { g } : {}), ...(u !== undefined ? { u } : {}) };
  }
  if (f['k'] === 'r') {
    const r = parseRoundFrame(f);
    if (!r) return null;
    // A stage that is off is left out, not the round with it: the round still goes on.
    const st = parseStage(f['st']);
    return st ? { ...r, st } : r;
  }
  const id = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  if (f['k'] === 'i') {
    const { x, z, vx, vz, y, vy, a } = f;
    if (!id(f['id']) || !num(x) || !num(z) || !num(vx) || !num(vz) || !num(y) || !num(vy) || typeof a !== 'boolean') return null;
    return { k: 'i', id: f['id'], x, z, vx, vz, y, vy, a };
  }
  if (f['k'] === 'p') {
    const { vx, vz, up } = f;
    if (!id(f['id']) || !num(vx, 100) || !num(vz, 100) || !num(up, SKY_TOP) || up < 0) return null;
    return { k: 'p', id: f['id'], vx, vz, up };
  }
  if (f['k'] === 'd') return Number.isSafeInteger(f['n']) && (f['n'] as number) > 0 ? { k: 'd', n: f['n'] as number } : null;
  if (f['k'] === 'w') {
    const { n, x, z } = f;
    if (!Number.isSafeInteger(n) || (n as number) <= 0 || !num(x, 1) || !num(z, 1) || Math.hypot(x, z) < 0.9) return null;
    const l = Math.hypot(x, z);
    return { k: 'w', n: n as number, x: x / l, z: z / l };
  }
  return null;
}

function parseStage(v: unknown): StageWire | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { u, a, w, g, b, by, i, f, nx } = v as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!Array.isArray(u) || u.length > 64 || !u.every((e: unknown) => Array.isArray(e) && e.length === 2 && isWho(e[0]) && count(e[1]))) return null;
  if (!Array.isArray(g) || g.length > 64 || !g.every((e: unknown) => Array.isArray(e) && e.length === 5 && count(e[0]) && isWho(e[1]) && ITEMS.includes(e[2] as Item) && num(e[3], GIGA_MOST) && count(e[4]))) return null;
  if ((a !== null && !isWho(a)) || typeof w !== 'boolean' || (by !== null && !isWho(by)) || !count(b) || !count(i) || !count(f) || !count(nx)) return null;
  return { u: u as [string, number][], a, w, g: g as StageWire['g'], b, by, i, f, nx };
}
