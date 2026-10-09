/**
 * The model behind the nightly soak (quality ticket 05, e2e/soak/soak.spec.ts): four friends, the actions they may take,
 * and what each action changes in what everyone should see. Pure and seeded, so a run is replayed from its seed or from its
 * action list, and a failing list can be shrunk by replaying parts of it in fresh rooms (`shrink`). No browser in here:
 * test/soak.test.ts checks it in the unit suite.
 *
 * The model is kept small on purpose: only what a friend sees and the app is plainly meant to keep. Every disruption (a
 * hidden tab, a cut socket, a browser gone offline) is over by the end of its step, so between steps everyone is
 * connected and the model has no "in between" states to guess at.
 */
import { DEFAULT_SHARE, MAX_VOLUME } from '../../src/core/settings';

export type Engine = 'chromium' | 'firefox';
/** The friends, Chromium and Firefox mixed. Only Chromium shares: its fake screen capture needs no picker (share.spec.ts). */
export const FRIENDS = [
  { name: 'Alice', engine: 'chromium' },
  { name: 'Bob', engine: 'firefox' },
  { name: 'Carol', engine: 'chromium' },
  { name: 'Dan', engine: 'firefox' },
] as const satisfies ReadonlyArray<{ name: string; engine: Engine }>;
export type Name = (typeof FRIENDS)[number]['name'];
export const NAMES: Name[] = FRIENDS.map((f) => f.name);
export const engineOf = (n: Name): Engine => FRIENDS.find((f) => f.name === n)!.engine;

export type Action =
  | { who: Name; do: 'join' | 'leave' | 'mute' | 'unmute' | 'share' | 'unshare' | 'reload' }
  | { who: Name; do: 'watch' | 'unwatch'; of: Name }
  /** A friend's volume for another, in percent. */
  | { who: Name; do: 'volume'; of: Name; value: number }
  | { who: Name; do: 'settings'; frameRate: number; maxHeight: number }
  | { who: Name; do: 'say'; text: string }
  /** Gone for `seconds`, then back: the tab hidden, the socket cut by the wire proxy, the browser offline. */
  | { who: Name; do: 'hide' | 'cut' | 'offline'; seconds: number };
export type Kind = Action['do'];

export type FriendState = {
  inCall: boolean;
  muted: boolean;
  sharing: boolean;
  /** Sharers whose share this friend watches. */
  watching: Name[];
  /** Volume per other friend, percent; 100 when never set. */
  volumes: Partial<Record<Name, number>>;
  frameRate: number;
  maxHeight: number;
};
export type Model = { friends: Record<Name, FriendState>; texts: string[] };

export function initialModel(): Model {
  const friends = {} as Record<Name, FriendState>;
  for (const n of NAMES) friends[n] = { inCall: false, muted: false, sharing: false, watching: [], volumes: {}, frameRate: DEFAULT_SHARE.frameRate, maxHeight: DEFAULT_SHARE.maxHeight };
  return { friends, texts: [] };
}

export const volumeOf = (m: Model, who: Name, of: Name): number => m.friends[who].volumes[of] ?? 100;
export const participants = (m: Model): Name[] => NAMES.filter((n) => m.friends[n].inCall);
export const sharers = (m: Model): Name[] => NAMES.filter((n) => m.friends[n].sharing);

/** Whether the action makes sense now. A replayed part of a list skips the actions that do not (see `play`). */
export function applicable(m: Model, a: Action): boolean {
  const me = m.friends[a.who];
  switch (a.do) {
    case 'join': return !me.inCall;
    case 'leave': return me.inCall;
    case 'mute': return me.inCall && !me.muted;
    case 'unmute': return me.inCall && me.muted;
    case 'share': return me.inCall && !me.sharing && engineOf(a.who) === 'chromium';
    case 'unshare': return me.sharing;
    case 'watch': return me.inCall && a.of !== a.who && m.friends[a.of].sharing && !me.watching.includes(a.of);
    case 'unwatch': return me.watching.includes(a.of);
    case 'volume': return me.inCall && a.of !== a.who && m.friends[a.of].inCall && volumeOf(m, a.who, a.of) !== a.value;
    case 'settings': return me.inCall && (me.frameRate !== a.frameRate || me.maxHeight !== a.maxHeight);
    case 'say': case 'reload': case 'hide': case 'cut': case 'offline': return true;
  }
}

/** What the action changes in what everyone should see. Only called with an applicable action. */
export function apply(m: Model, a: Action): Model {
  const next: Model = { texts: [...m.texts], friends: structuredClone(m.friends) };
  const me = next.friends[a.who];
  /** A share that ends ends for everyone watching it. */
  const endShare = () => {
    me.sharing = false;
    for (const n of NAMES) next.friends[n].watching = next.friends[n].watching.filter((s) => s !== a.who);
  };
  switch (a.do) {
    case 'join': me.inCall = true; me.watching = []; break;
    // Leaving ends my share and every watch of mine; joining again starts with every tile at "click to watch".
    case 'leave': me.inCall = false; endShare(); me.watching = []; break;
    // Mute is remembered by the browser, also across leaving and reloads.
    case 'mute': me.muted = true; break;
    case 'unmute': me.muted = false; break;
    case 'share': me.sharing = true; break;
    case 'unshare': endShare(); break;
    case 'watch': me.watching = [...me.watching, a.of]; break;
    case 'unwatch': me.watching = me.watching.filter((s) => s !== a.of); break;
    case 'volume': me.volumes = { ...me.volumes, [a.of]: a.value }; break;
    case 'settings': me.frameRate = a.frameRate; me.maxHeight = a.maxHeight; break;
    case 'say': next.texts.push(a.text); break;
    // A reload in a call rejoins it (ticket 24) with the shares I watched, but a share of mine needs a new click.
    case 'reload': endShare(); break;
    case 'hide': case 'cut': case 'offline': break;
  }
  return next;
}

/** A small seeded PRNG (mulberry32): the same seed gives the same run. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How often each action is picked among the ones that make sense: mostly calls and shares, some chaos. */
const WEIGHTS: Record<Kind, number> = {
  join: 4, leave: 1, mute: 1, unmute: 2, share: 3, unshare: 1, watch: 4, unwatch: 1,
  settings: 1, volume: 1, say: 2, reload: 1, hide: 1, cut: 1, offline: 1,
};
const FRAME_RATES = [15, 30, 60];
const HEIGHTS = [0, 1080, 720];
const VOLUMES = Array.from({ length: MAX_VOLUME * 4 + 1 }, (_, i) => i * 25); // 0 to 200 in steps of 25

/** The actions that make sense now, each friend's alike, parameters picked from `rand`. Step `i` names its text. */
function candidates(m: Model, rand: () => number, i: number): Action[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const out: Action[] = [];
  for (const who of NAMES) {
    for (const d of ['join', 'leave', 'mute', 'unmute', 'share', 'unshare', 'reload'] as const) out.push({ who, do: d });
    for (const of of NAMES) {
      out.push({ who, do: 'watch', of }, { who, do: 'unwatch', of });
      out.push({ who, do: 'volume', of, value: pick(VOLUMES) });
    }
    out.push({ who, do: 'settings', frameRate: pick(FRAME_RATES), maxHeight: pick(HEIGHTS) });
    out.push({ who, do: 'say', text: `t${i} from ${who}` });
    for (const d of ['hide', 'cut', 'offline'] as const) out.push({ who, do: d, seconds: 2 + Math.floor(rand() * 5) });
  }
  return out.filter((a) => applicable(m, a));
}

/** `count` actions from `seed`, each one applicable after the ones before. */
export function generate(seed: number, count: number): Action[] {
  const rand = prng(seed);
  let m = initialModel();
  const out: Action[] = [];
  for (let i = 0; i < count; i++) {
    const options = candidates(m, rand, i);
    const total = options.reduce((s, a) => s + WEIGHTS[a.do], 0);
    let r = rand() * total;
    const a = options.find((o) => (r -= WEIGHTS[o.do]) < 0) ?? options[options.length - 1]!;
    out.push(a);
    m = apply(m, a);
  }
  return out;
}

/** The actions of a list that make sense in order, the others dropped: what a replay of the list actually does. */
export function effective(list: Action[]): Action[] {
  let m = initialModel();
  return list.filter((a) => (applicable(m, a) ? ((m = apply(m, a)), true) : false));
}

// --- one line per action, e.g. "Bob watch Alice", "Dan volume Bob 50", "Alice settings 15 720", "Carol cut 3"

export function format(a: Action): string {
  switch (a.do) {
    case 'watch': case 'unwatch': return `${a.who} ${a.do} ${a.of}`;
    case 'volume': return `${a.who} volume ${a.of} ${a.value}`;
    case 'settings': return `${a.who} settings ${a.frameRate} ${a.maxHeight}`;
    case 'say': return `${a.who} say ${a.text}`;
    case 'hide': case 'cut': case 'offline': return `${a.who} ${a.do} ${a.seconds}`;
    default: return `${a.who} ${a.do}`;
  }
}

export const formatList = (list: Action[]): string => list.map(format).join('; ');

export function parse(line: string): Action {
  const [who, d, ...rest] = line.trim().split(/\s+/);
  const bad = () => new Error(`not a soak action: "${line}"`);
  if (!NAMES.includes(who as Name)) throw bad();
  const w = who as Name;
  const num = (s: string | undefined) => { const n = Number(s); if (s === undefined || !Number.isFinite(n)) throw bad(); return n; };
  const name = (s: string | undefined) => { if (!NAMES.includes(s as Name)) throw bad(); return s as Name; };
  switch (d) {
    case 'join': case 'leave': case 'mute': case 'unmute': case 'share': case 'unshare': case 'reload': return { who: w, do: d };
    case 'watch': case 'unwatch': return { who: w, do: d, of: name(rest[0]) };
    case 'volume': return { who: w, do: d, of: name(rest[0]), value: num(rest[1]) };
    case 'settings': return { who: w, do: d, frameRate: num(rest[0]), maxHeight: num(rest[1]) };
    case 'say': if (!rest.length) throw bad(); return { who: w, do: d, text: rest.join(' ') };
    case 'hide': case 'cut': case 'offline': return { who: w, do: d, seconds: num(rest[0]) };
    default: throw bad();
  }
}

export const parseList = (s: string): Action[] => s.split(/[;\n]/).map((l) => l.trim()).filter(Boolean).map(parse);

/**
 * Delta debugging (ddmin) over a failing list: drops ever smaller chunks while the rest still fails, until no single
 * action can go or `more()` says the budget is spent. `fails` replays a list in fresh rooms. Returns the shortest list
 * that failed and how many replays it took.
 */
export async function shrink<T>(list: T[], fails: (l: T[]) => Promise<boolean>, more: () => boolean): Promise<{ list: T[]; replays: number; complete: boolean }> {
  let current = list;
  let n = 2;
  let replays = 0;
  while (current.length >= 2) {
    const size = Math.ceil(current.length / n);
    let reduced = false;
    for (let start = 0; start < current.length; start += size) {
      if (!more()) return { list: current, replays, complete: false };
      const rest = [...current.slice(0, start), ...current.slice(start + size)];
      replays++;
      if (await fails(rest)) { current = rest; n = Math.max(n - 1, 2); reduced = true; break; }
    }
    if (!reduced) {
      if (size === 1) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return { list: current, replays, complete: true };
}
