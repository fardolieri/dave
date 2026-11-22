// Clink on screen (core/clink.ts): the table, the tower of coins in its middle, everyone's chips round it, in three.js;
// the stakes, the grab, double or nothing and the shop, as buttons and keys; the sounds; the match and its tower, run by
// the leader (core/rounds.ts), followed by everyone else. Loaded only once a friend plays it (client/Game.tsx).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  CLIMBS, COUNT_MS, FELL, MULTS, OFF, RIDING, SHOP, TOP, UPGRADES,
  advance, buy, canFlip, climbFrame, climbOf, costOf, earn, flip, flipStake, follow, grab, newSeat, nextOdds, parseFrame, payout, raiseOf, seatFrame,
  type Climb, type ClinkView, type Counted, type Seat, type SeatFrame, type Share, type Upgrade,
} from '../core/clink';
import { firstRound, leaderOf, roundFrame, roundOf, whoOf, type Round } from '../core/rounds';
import type { GameLinks } from './gamelinks';
import { exposeHooks } from './hooks';
import { cueContext } from './sound';
import { isTyping, nameTag, popWord, skin, threeColourOf, thump, type Face } from './gamekit';

const SEND_MS = 100;
const ROUND_SEND_MS = 250;
const CLIMB_SEND_MS = 150;
const HEARD_MS = 2500;
/** The tower: a coin's radius and thickness, where the first sits, how long the next takes to drop onto it. */
const COIN_R = 1;
const COIN_H = 0.24;
const BASE_Y = 0.75;
const DROP_MS = 380;
const TABLE_R = 9;
const MOOD_NAMES = ['steady', 'wobbly', 'shaky'] as const;
const MOOD_COLOURS = ['#3ddc84', '#ffb020', '#ff4d4d'] as const;
const SHARE_LABELS: Record<Share, string> = { 4: '¼', 2: '½', 1: 'All' };
const LITE_MS = 60;
/** Chip colours told apart at a glance, one each in the table's order (client/skid.ts does the same for karts). */
const PALETTE = ['#e5484d', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

/**
 * Whether WebGL is drawn without a GPU. The renderer's own name where the browser gives it (Firefox), else the debug
 * extension's (Chromium and Safari mask the plain one; Firefox warns of the extension, so it is asked only there).
 */
function isSoftware(gl: WebGL2RenderingContext): boolean {
  let name = String(gl.getParameter(gl.RENDERER) ?? '');
  if (/^WebKit WebGL$/i.test(name)) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  }
  return /SwiftShader|llvmpipe|softpipe|Software/i.test(name);
}

type Other = { key: string; frame: SeatFrame; at: number };

/** Chips as they are read: in full up to ten thousand, then 12.3K, 4.56M and so on. */
export function chipsText(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 10_000) return v.toLocaleString('en-US');
  const units = ['K', 'M', 'B', 'T', 'Qa'];
  let x = v / 1000, i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}${units[i]}`;
}
const multText = (m: number): string => `×${m >= 10 ? m.toFixed(0) : m.toFixed(1)}`;

/** A canvas texture drawn by `draw` on a `w` × `h` canvas. */
function painted(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A number from a few others, 0 to 1, the same on every screen: where a coin sits on the one below. */
function hashed(...xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) { h ^= x * 374761393; h = Math.imul(h, 16777619) >>> 0; }
  return (h % 10_000) / 10_000;
}

// The sounds, made as they play, through the cues' audio (client/sound.ts).
function tone(f: number, at: number, len: number, gain: number, type: OscillatorType = 'sine'): void {
  const c = cueContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + len + 0.02);
}
/** A coin on a coin: higher the higher the tower. */
const clinkSound = (h: number, at = 0, loud = 0.12): void => { const f = 1400 + h * 70; tone(f, at, 0.25, loud); tone(f * 2.76, at, 0.12, loud * 0.5); tone(f * 5.4, at, 0.05, loud * 0.25); };
/** Coins pouring in: a run of clinks, more for more. */
const pour = (n: number): void => { for (let i = 0; i < n; i++) clinkSound(Math.random() * 14, i * 0.045 + Math.random() * 0.02, 0.06); };
const fanfare = (): void => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.35, 0.12, 'triangle')); };
const crash = (): void => {
  const c = cueContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.7), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 3000;
  const g = c.createGain();
  g.gain.value = 0.3;
  src.connect(filter).connect(g).connect(c.destination);
  src.start(t);
  for (let i = 0; i < 9; i++) clinkSound(Math.random() * 20, 0.05 + i * 0.06 + Math.random() * 0.05, 0.05);
  tone(180, 0, 0.5, 0.15, 'sawtooth');
};

/** Where seat `i` of `n` is round the table, as an angle: on its far side, spread out, none right behind the tower. */
function seatAngle(i: number, n: number): number {
  const from = Math.PI * 1.18, to = Math.PI * 1.82;
  let a = n <= 1 ? Math.PI * 1.3 : from + (i / (n - 1)) * (to - from);
  const behind = Math.PI * 1.5, gap = 0.3;
  if (Math.abs(a - behind) < gap) a = behind + (a < behind || (a === behind && i % 2 === 0) ? -gap : gap);
  return a;
}

/** Clink, in `host`, for me (`me`, my key), over `links` to the other players. Returns how to stop it. */
export function mountClink(host: HTMLElement, opts: { me: string; links: GameLinks; faceOf: (key: string) => Face }): () => void {
  const { me, links } = opts;
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  let round: Round = firstRound(performance.now());
  let climb: Climb | null = null;
  let seat: Seat = newSeat();
  /** The match I play; 0 while I watch one, or none is on (waiting, I practise). */
  let playing = 0;
  let leader: string | null = me;
  const roundSeq = new Map<string, number>();
  const climbSeq = new Map<string, number>();
  let sentQ = 0;
  let last = performance.now();
  let lastSeatSent = 0, lastRoundSent = 0, lastClimbSent = 0;
  /** For tests (`window.__daveClinkRig`): what the leader's every roll comes out as; null for chance. */
  let rig: number | null = null;
  const rand = (): number => rig ?? Math.random();

  type Ev =
    | { kind: 'land'; h: number; gold: boolean } | { kind: 'fell' } | { kind: 'top' } | { kind: 'grab'; who: string; won: number; h: number }
    | { kind: 'gilded'; who: string; amount: number } | { kind: 'flip'; who: string; win: boolean; amount: number } | { kind: 'interest'; amount: number }
    | { kind: 'beep' } | { kind: 'go' } | { kind: 'won' };
  const events: Ev[] = [];
  let lastBeep = -1;

  const watching = () => playing === 0 && (round.phase === 'count' || round.phase === 'play');
  /** Whether my seat is in the climb going on: while waiting, every climb is practice for whoever is there. */
  const seated = () => round.phase === 'wait' || (round.phase === 'play' && playing === round.n && playing > 0);
  const heard = (now: number): Other[] => [...others.values()].filter((o) => now - o.at < HEARD_MS);
  const worth = (s: { chips: number; stake: number; at: number }) => s.chips + (s.at === RIDING ? s.stake : 0);

  const took = (next: Round) => {
    const was = round;
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    if (next.phase === 'count') {
      playing = next.players.includes(myWho) ? next.n : 0;
      seat = { ...newSeat(), share: seat.share };
      climb = null;
    } else if (next.phase === 'play') {
      if (playing !== next.n) playing = 0;
      else events.push({ kind: 'go' });
    } else if (next.phase === 'wait') {
      playing = 0;
      seat = { ...newSeat(), share: seat.share };
      climb = null;
    } else if (next.phase === 'over') {
      climb = null;
      if (next.winner === myWho && playing === next.n) events.push({ kind: 'won' });
    }
  };

  /** The climb as it now stands, from the leader's run or its frames; what changed, as events. */
  const tookClimb = (next: Climb | null) => {
    const was = climb;
    climb = next;
    if (!next || !was || next.c !== was.c) {
      // A tower first seen already fallen is not put up to fall again.
      if (next && next.fell >= 0 && next.h < TOP) toppled = next.c;
      return;
    }
    for (let k = was.h + 1; k <= next.h; k++) events.push({ kind: 'land', h: k, gold: next.gold.some(([g]) => g === k) });
    if (next.fell >= 0 && was.fell < 0) events.push({ kind: next.h >= TOP ? 'top' : 'fell' });
  };

  const offFrames = links.listen((from, data) => {
    const f = parseFrame(data);
    if (!f) return;
    const now = performance.now();
    if (f.k === 's') {
      const was = others.get(from)?.frame;
      others.set(from, { key: from, frame: f, at: now });
      if (was && was.c === f.c) {
        if (was.a === RIDING && f.a >= 0) events.push({ kind: 'grab', who: from, won: f.w, h: f.a });
        if (f.g > was.g) events.push({ kind: 'gilded', who: from, amount: f.g - was.g });
        if (was.f === 0 && f.f !== 0) events.push({ kind: 'flip', who: from, win: f.f === 1, amount: Math.max(0, f.w - f.st) });
      }
      return;
    }
    if (from !== leader) return;
    if (f.k === 'r') {
      if (f.q <= (roundSeq.get(from) ?? -1)) return;
      roundSeq.set(from, f.q);
      const next = roundOf(f, now);
      took(next.n === round.n && next.phase === round.phase && Math.abs(next.since - round.since) < 150 ? { ...next, since: round.since } : next);
      return;
    }
    if (f.q <= (climbSeq.get(from) ?? -1) || f.n !== round.n || round.phase === 'count' || round.phase === 'over') return;
    climbSeq.set(from, f.q);
    const next = climbOf(f, now);
    // The same climb keeps its start, unless the leader's says otherwise by more than a frame's wander.
    tookClimb(climb && climb.c === next.c && Math.abs(next.t0 - climb.t0) < 150 ? { ...next, t0: climb.t0 } : next);
  });

  function step(now: number): void {
    const dt = now - last;
    last = now;
    const around = heard(now);
    leader = leaderOf([{ key: me, n: round.n }, ...around.map((o) => ({ key: o.key, n: o.frame.n }))]);
    if (leader === me) {
      const counted: Counted[] = [
        { who: myWho, n: playing, known: round.n, chips: worth(seat), riding: seated() && seat.at === RIDING },
        ...around.map((o) => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n, chips: o.frame.ch + (o.frame.a === RIDING ? o.frame.st : 0), riding: o.frame.a === RIDING && o.frame.c === climb?.c })),
      ];
      const next = advance({ round, climb }, now, counted, rand);
      if (next.round !== round) { took(next.round); lastRoundSent = 0; }
      if (next.climb !== climb) { tookClimb(next.climb); lastClimbSent = 0; }
      if (now - lastRoundSent >= ROUND_SEND_MS) { sentQ = Math.max(Date.now(), sentQ + 1); links.broadcast(JSON.stringify(roundFrame(round, now, sentQ))); lastRoundSent = now; }
      if (climb && now - lastClimbSent >= CLIMB_SEND_MS) { sentQ = Math.max(Date.now(), sentQ + 1); links.broadcast(JSON.stringify(climbFrame(climb, round.n, now, sentQ))); lastClimbSent = now; }
    }
    // My seat, as the climb goes.
    if (seated()) {
      seat = earn(seat, dt);
      if (climb) {
        const was = seat;
        seat = follow(seat, climb, now - climb.t0);
        if (seat.gilded > was.gilded && seat.c === was.c) events.push({ kind: 'gilded', who: me, amount: seat.gilded - was.gilded });
        if (seat.interest > 0 && was.interest < 0 && seat.c === was.c) events.push({ kind: 'interest', amount: seat.interest });
        if (was.at === RIDING && seat.at >= 0) events.push({ kind: 'grab', who: me, won: seat.won, h: seat.at });
        // The stakes' last seconds.
        const left = Math.ceil((climb.bet - (now - climb.t0)) / 1000);
        if (left !== lastBeep && left >= 1 && left <= 3) { lastBeep = left; events.push({ kind: 'beep' }); }
      }
    }
    if (round.phase === 'count' && !watching()) {
      const left = Math.ceil((COUNT_MS - (now - round.since)) / 1000);
      if (left !== lastBeep && left >= 1 && left <= 3) { lastBeep = left; events.push({ kind: 'beep' }); }
    }
    if (now - lastSeatSent >= SEND_MS) {
      links.broadcast(JSON.stringify(seatFrame(seat, watching() ? 0 : playing, round.n)));
      lastSeatSent = now;
    }
  }

  // What I do: grab, double or nothing, my share, the shop.
  /** Whether a grab now is one: on the tower, the stakes closed, and the next coin not yet due, by my clock. */
  const canGrab = (now: number): boolean => {
    if (!seated() || !climb || seat.at !== RIDING || seat.c !== climb.c || climb.fell >= 0) return false;
    const ms = now - climb.t0;
    return ms >= climb.bet && ms < climb.next;
  };
  const doGrab = () => { const now = performance.now(); if (canGrab(now)) { seat = grab(seat, climb!.h); events.push({ kind: 'grab', who: me, won: seat.won, h: seat.at }); lastSeatSent = 0; } };
  const doFlip = () => {
    if (!seated() || !canFlip(seat)) return;
    const amount = flipStake(seat);
    seat = flip(seat, Math.random());
    events.push({ kind: 'flip', who: me, win: seat.flip === 1, amount });
    lastSeatSent = 0;
  };
  const doShare = (s: Share) => { seat = { ...seat, share: s }; };
  const doBuy = (u: Upgrade) => { if (!seated()) return; const next = buy(seat, u); if (next !== seat) { seat = next; pour(4); lastSeatSent = 0; } };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' || e.code === 'Enter') { if (!e.repeat) doGrab(); e.preventDefault(); }
    else if (e.code === 'KeyF') { if (!e.repeat) doFlip(); e.preventDefault(); }
    else if (e.code === 'Digit1') { doShare(4); e.preventDefault(); }
    else if (e.code === 'Digit2') { doShare(2); e.preventDefault(); }
    else if (e.code === 'Digit3') { doShare(1); e.preventDefault(); }
  };
  host.tabIndex = 0;
  host.addEventListener('keydown', onKeyDown);
  const onPointerDown = () => host.focus({ preventScroll: true });
  host.addEventListener('pointerdown', onPointerDown);

  // The HUD.
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };
  const hud = el('div', 'bonk-hud clink-hud');
  const banner = el('div', 'bonk-banner');
  const board = el('ol', 'clink-board');
  const pot = el('div', 'clink-pot');
  const gauge = el('div', 'clink-gauge');
  const mult = el('div', 'clink-mult');
  const oddsEl = el('div', 'clink-odds');
  gauge.append(mult, oddsEl, pot);
  const results = el('ol', 'skid-results clink-results');
  const side = el('div', 'clink-side');
  const panel = el('div', 'clink-panel');
  const chipsLine = el('div', 'clink-chips');
  const shares = el('div', 'clink-shares');
  const shareButtons = ([4, 2, 1] as Share[]).map((s) => {
    const b = el('button', 'clink-share');
    b.type = 'button';
    b.dataset['share'] = String(s);
    b.addEventListener('click', (e) => { e.stopPropagation(); doShare(s); });
    shares.append(b);
    return { s, b };
  });
  const act = el('button', 'clink-act');
  act.type = 'button';
  act.addEventListener('click', (e) => { e.stopPropagation(); if (canGrab(performance.now())) doGrab(); else doFlip(); });
  const shop = el('div', 'clink-shop');
  const shopButtons = UPGRADES.map((u) => {
    const b = el('button', 'clink-buy');
    b.type = 'button';
    b.dataset['upgrade'] = u;
    b.addEventListener('click', (e) => { e.stopPropagation(); doBuy(u); });
    shop.append(b);
    return { u, b };
  });
  const help = el('div', 'bonk-help clink-help', 'Space grabs · F double or nothing · 1 2 3 stake ¼ ½ all');
  panel.append(chipsLine, shares, act, shop);
  side.append(gauge, panel);
  hud.append(banner, board, side, results, help);
  host.append(hud);

  // The scene, in WebGL 2, which three.js needs; a browser without it plays all the same, blind (client/bonk.ts too).
  let renderer: THREE.WebGLRenderer | null = null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  try {
    renderer = context ? new THREE.WebGLRenderer({ canvas, context, antialias: true }) : null;
  } catch {
    renderer = null;
  }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#120d0a');
  scene.fog = new THREE.Fog('#120d0a', 22, 48);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  const owned: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => { owned.push(x); return x; };
  let envMap: THREE.Texture | null = null;
  // A renderer without a GPU (SwiftShader, llvmpipe: a headless browser, an old machine) draws the table lit plainly:
  // no reflections, no shadows, fewer frames. So does one that turns out slow (`governor`, below).
  let lite = context !== null && isSoftware(context);
  if (renderer && !lite) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    envMap = pmrem.fromScene(room, 0.04).texture;
    scene.environment = envMap;
    scene.environmentIntensity = 0.55;
    room.dispose();
    pmrem.dispose();
  }
  const sky = new THREE.HemisphereLight('#ffe8c4', '#1a0f08', 0.7);
  scene.add(sky);
  const spot = new THREE.SpotLight('#ffd9a0', 260, 40, Math.PI / 5, 0.45, 1.6);
  spot.position.set(0, 18, 3);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  scene.add(spot, spot.target);
  const glow = new THREE.PointLight('#ffcc55', 0, 14, 2);
  scene.add(glow);

  // The table: green felt, a wooden rim.
  const felt = new THREE.Mesh(keep(new THREE.CylinderGeometry(TABLE_R, TABLE_R, 0.5, 72)), keep(new THREE.MeshStandardMaterial({
    color: '#0e5a3a', roughness: 0.95,
    map: keep(painted(256, 256, (g) => { g.fillStyle = '#0e5a3a'; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 2600; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.05)'; g.fillRect(Math.random() * 256, Math.random() * 256, 1, 1); } })),
  })));
  felt.position.y = 0.25;
  felt.receiveShadow = true;
  const rim = new THREE.Mesh(keep(new THREE.TorusGeometry(TABLE_R, 0.45, 16, 96)), keep(new THREE.MeshStandardMaterial({ color: '#5a2e14', roughness: 0.5, metalness: 0.1 })));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.5;
  const ring = new THREE.Mesh(keep(new THREE.RingGeometry(2.1, 2.2, 64)), keep(new THREE.MeshBasicMaterial({ color: '#d9b45a', transparent: true, opacity: 0.6 })));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.51;
  const pedestal = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.35, 1.5, 0.25, 48)), keep(new THREE.MeshStandardMaterial({ color: '#2b1a10', roughness: 0.4, metalness: 0.3 })));
  pedestal.position.y = 0.62;
  pedestal.receiveShadow = true;
  scene.add(felt, rim, ring, pedestal);

  // Coins: a milled edge, a star on each face; golden ones glow.
  const coinGeo = keep(new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_H, 48));
  const edgeTex = keep(painted(512, 16, (g) => { for (let x = 0; x < 512; x += 4) { g.fillStyle = x % 8 ? '#b8862b' : '#f2cf6b'; g.fillRect(x, 0, 4, 16); } }));
  const faceTex = keep(painted(256, 256, (g) => {
    const grd = g.createRadialGradient(128, 128, 20, 128, 128, 128);
    grd.addColorStop(0, '#ffe7a0'); grd.addColorStop(0.75, '#e2b24a'); grd.addColorStop(0.92, '#b8862b'); grd.addColorStop(1, '#f2cf6b');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(120,80,20,.6)'; g.lineWidth = 6; g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(150,100,30,.75)'; g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 26 : 62, a = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); }
    g.closePath(); g.fill();
  }));
  const gold = (emissive: string, intensity: number) => [
    keep(new THREE.MeshStandardMaterial({ map: edgeTex, metalness: 0.9, roughness: 0.3, emissive, emissiveIntensity: intensity })),
    keep(new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.85, roughness: 0.28, emissive, emissiveIntensity: intensity })),
    keep(new THREE.MeshStandardMaterial({ map: faceTex, metalness: 0.85, roughness: 0.28, emissive, emissiveIntensity: intensity })),
  ];
  const coinMat = gold('#000000', 0);
  const goldenMat = gold('#ffb000', 0.9);
  const moodMats = MOOD_COLOURS.map((c) => gold(c, 0.35));
  /** Plainly lit from here on: metal with nothing to reflect looks dark, so the coins are made less of it. */
  const goLite = () => {
    lite = true;
    scene.environment = null;
    sky.intensity = 1.6;
    spot.castShadow = false;
    if (renderer) { renderer.shadowMap.enabled = false; renderer.setPixelRatio(0.75); resize(); }
    for (const m of [...coinMat, ...goldenMat, ...moodMats.flat()]) { const st = m as THREE.MeshStandardMaterial; st.metalness = 0.35; st.roughness = 0.45; st.needsUpdate = true; }
    for (const s of shown.values()) for (const m of [...s.mats, ...s.chipMat]) m.needsUpdate = true;
  };
  const makeCoin = (mats: THREE.Material[]) => { const m = new THREE.Mesh(coinGeo, mats); m.castShadow = true; m.receiveShadow = true; return m; };
  const tower = new THREE.Group();
  tower.position.y = BASE_Y;
  scene.add(tower);
  const stacked: THREE.Mesh[] = [];
  const dropping = makeCoin(moodMats[1]!);
  scene.add(dropping);
  let shownClimb = 0;
  /** The climb whose tower has fallen on screen: not built again. */
  let toppled = 0;
  const coinSpot = (c: number, k: number) => ({ x: (hashed(c, k, 1) - 0.5) * 0.16, z: (hashed(c, k, 2) - 0.5) * 0.16, r: hashed(c, k, 3) * Math.PI });
  // Coins flying off a fallen tower, and sparks: each moved here until gone.
  type Flying = { mesh: THREE.Object3D; v: THREE.Vector3; spin: THREE.Vector3; until: number; floor: number };
  const flying: Flying[] = [];
  const sparkGeo = keep(new THREE.BoxGeometry(0.12, 0.12, 0.02));
  const sparkMat = keep(new THREE.MeshBasicMaterial({ color: '#ffd84a' }));
  const burst = (at: THREE.Vector3, n: number, now: number, speed = 6) => {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(sparkGeo, sparkMat);
      m.position.copy(at);
      scene.add(m);
      const a = Math.random() * Math.PI * 2, up = 0.5 + Math.random();
      flying.push({ mesh: m, v: new THREE.Vector3(Math.cos(a) * speed * Math.random(), up * speed, Math.sin(a) * speed * Math.random()), spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, 0), until: now + 1400, floor: 0.5 });
    }
  };
  const topple = (now: number) => {
    const world = new THREE.Vector3();
    for (const m of stacked.splice(0)) {
      m.getWorldPosition(world);
      tower.remove(m);
      m.position.copy(world);
      scene.add(m);
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
      flying.push({ mesh: m, v: new THREE.Vector3(Math.cos(a) * s, 1 + Math.random() * 5, Math.sin(a) * s), spin: new THREE.Vector3(Math.random() * 10, 0, Math.random() * 10), until: now + 2600, floor: 0.5 + COIN_H / 2 });
    }
  };

  // The pot: a heap of coins beside the tower, as big as it is.
  const potHeap = new THREE.Group();
  potHeap.position.set(3.6, 0.5, -2.4);
  scene.add(potHeap);
  const potCoins: THREE.Mesh[] = [];
  for (let i = 0; i < 24; i++) {
    const m = makeCoin(coinMat);
    const a = hashed(i, 7) * Math.PI * 2, r = hashed(i, 8) * 0.9;
    m.scale.setScalar(0.55);
    m.position.set(Math.cos(a) * r, COIN_H * 0.55 * (0.5 + Math.floor(i / 6)), Math.sin(a) * r);
    m.rotation.set((hashed(i, 9) - 0.5) * 0.5, 0, (hashed(i, 10) - 0.5) * 0.5);
    potHeap.add(m);
    potCoins.push(m);
  }

  // The players round the table: their chips in a pile, their face behind it, their name over it; their stake, while
  // on the tower, in front of the tower on their side.
  const chipGeo = keep(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 28));
  const headGeo = keep(new THREE.SphereGeometry(0.55, 28, 20));
  type Shown = { group: THREE.Group; pile: THREE.Group; stake: THREE.Group; head: THREE.Mesh; tag: THREE.Sprite; face: string; mats: THREE.Material[]; chipMat: THREE.Material[]; angle: number; pops: { s: THREE.Sprite; born: number }[] };
  const shown = new Map<string, Shown>();
  const chipMaterials = (colour: string): THREE.Material[] => {
    const side = painted(256, 16, (g) => { g.fillStyle = colour; g.fillRect(0, 0, 256, 16); g.fillStyle = '#fff'; for (let x = 8; x < 256; x += 43) g.fillRect(x, 3, 14, 10); });
    const top = painted(128, 128, (g) => { g.fillStyle = colour; g.fillRect(0, 0, 128, 128); g.strokeStyle = '#fff'; g.lineWidth = 8; g.setLineDash([14, 12]); g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(64, 64, 30, 0, Math.PI * 2); g.fill(); });
    return [new THREE.MeshStandardMaterial({ map: side, roughness: 0.5 }), new THREE.MeshStandardMaterial({ map: top, roughness: 0.5 }), new THREE.MeshStandardMaterial({ map: top, roughness: 0.5 })];
  };
  const chipCount = (chips: number) => Math.max(1, Math.min(40, Math.round(Math.log10(Math.max(1, chips)) * 4)));
  const fillStack = (g: THREE.Group, n: number, mats: THREE.Material[]) => {
    while (g.children.length > n) g.remove(g.children[g.children.length - 1]!);
    while (g.children.length < n) {
      const i = g.children.length;
      const m = new THREE.Mesh(chipGeo, mats);
      m.position.set((hashed(i, 4) - 0.5) * 0.06, 0.05 + i * 0.1, (hashed(i, 5) - 0.5) * 0.06);
      m.castShadow = true;
      g.add(m);
    }
  };
  const show = (key: string, seatNo: number): Shown => {
    const f = opts.faceOf(key);
    const colour = seatNo >= 0 ? PALETTE[seatNo % PALETTE.length]! : `#${threeColourOf(key).getHexString()}`;
    const id = `${f.name}\n${f.picture ?? ''}\n${colour}`;
    let s = shown.get(key);
    if (s && s.face === id) return s;
    if (s) { scene.remove(s.group); disposeShown(s); }
    const chipMat = chipMaterials(colour);
    const headMat = new THREE.MeshStandardMaterial({ map: skin(f, colour), roughness: 0.45 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.castShadow = true;
    const pile = new THREE.Group();
    const stake = new THREE.Group();
    const tag = nameTag(key === me ? 'You' : f.name, key === me);
    const group = new THREE.Group();
    group.add(head, pile, tag);
    scene.add(group, stake);
    s = { group, pile, stake, head, tag, face: id, mats: [headMat], chipMat, angle: 0, pops: [] };
    shown.set(key, s);
    return s;
  };
  function disposeShown(s: Shown): void {
    scene.remove(s.stake);
    for (const m of [...s.mats, ...s.chipMat]) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
    for (const p of s.pops) { p.s.material.map?.dispose(); p.s.material.dispose(); }
    s.tag.material.map?.dispose();
    s.tag.material.dispose();
  }
  const pop = (key: string, text: string, colour: string, now: number) => {
    const s = shown.get(key);
    if (!s) return;
    const p = popWord(text, colour);
    p.scale.set(3.4, 1.7, 1);
    s.group.add(p);
    p.position.set(0, 3.2, 0);
    s.pops.push({ s: p, born: now });
  };

  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = !lite;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.domElement.className = 'bonk-canvas';
    host.prepend(renderer.domElement);
  } else {
    help.textContent = 'This browser cannot draw the game (no WebGL), but you are in it.';
  }
  /** The scene's middle moved out from under the controls: left of them when they stand at the side, above when below. */
  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer?.setSize(w, h, false);
    camera.aspect = w / h;
    const box = host.getBoundingClientRect(), p = panel.getBoundingClientRect();
    const there = !side.hidden && !panel.hidden && p.width > 0;
    const atSide = there && p.left - box.left > w / 2;
    const x = atSide ? (box.right - p.left) / 2 : 0;
    const y = there && !atSide ? Math.min(h / 4, (box.bottom - p.top) / 2) : 0;
    if (x || y) camera.setViewOffset(w, h, x, y, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  const sizer = new ResizeObserver(resize);
  sizer.observe(host);
  if (lite) goLite();
  resize();

  let shake = 0;
  let glowUntil = 0;
  const camAt = new THREE.Vector3(0, 5, 11);
  const lookAt = new THREE.Vector3(0, 1.5, -0.8);

  function draw(now: number, dt: number): void {
    const s = dt / 1000;
    // Who sits where: those in the match (while waiting or after one, everyone), round the far side of the table, facing
    // the camera, in their keys' order; nobody right behind the tower.
    const inMatch = round.phase === 'play' || round.phase === 'count';
    const players = [...(watching() ? [] : [me]), ...heard(now).filter((o) => !inMatch || o.frame.r === round.n).map((o) => o.key)];
    const order = [...players].sort();
    const keysShown = new Set<string>();
    for (const key of players) {
      const sh = show(key, order.indexOf(key));
      keysShown.add(key);
      const frame = key === me ? null : others.get(key)?.frame ?? null;
      const chips = key === me ? seat.chips : frame?.ch ?? 0;
      const at = key === me ? seat.at : frame?.a ?? OFF;
      const stakeAmt = key === me ? seat.stake : frame?.st ?? 0;
      const sameClimb = key === me ? seat.c === climb?.c : frame?.c === climb?.c;
      const i = order.indexOf(key);
      const angle = seatAngle(i, order.length);
      sh.angle = angle;
      const r = TABLE_R - 3;
      const px = Math.cos(angle) * r, pz = Math.sin(angle) * r;
      sh.group.position.set(px, 0.5, pz);
      sh.group.visible = true;
      sh.head.position.set(Math.cos(angle) * 1.1, 1.05 + Math.sin(now / 500 + i) * 0.04, Math.sin(angle) * 1.1);
      sh.head.rotation.y = Math.atan2(-px, 12 - pz) * 0.8;
      sh.tag.position.set(Math.cos(angle) * 1.1, 2.15, Math.sin(angle) * 1.1);
      fillStack(sh.pile, chipCount(chips), sh.chipMat);
      const riding = sameClimb && at === RIDING && stakeAmt > 0;
      sh.stake.visible = riding;
      if (riding) {
        fillStack(sh.stake, Math.max(1, Math.round(chipCount(stakeAmt) / 2)), sh.chipMat);
        sh.stake.position.set(Math.cos(angle) * 2.5, 0.5, Math.sin(angle) * 2.5);
      }
      for (const p of sh.pops.splice(0)) {
        const age = now - p.born;
        if (age > 1600) { sh.group.remove(p.s); p.s.material.map?.dispose(); p.s.material.dispose(); continue; }
        p.s.position.y = 3.2 + age / 700;
        p.s.material.opacity = Math.min(1, 2 - age / 800);
        sh.pops.push(p);
      }
    }
    for (const [key, sh] of shown) if (!keysShown.has(key)) { sh.group.visible = false; sh.stake.visible = false; }

    // The tower, as the climb has it.
    const cl = climb;
    if (!cl || cl.c !== shownClimb) {
      for (const m of stacked.splice(0)) tower.remove(m);
      shownClimb = cl?.c ?? 0;
    }
    const ms = cl ? now - cl.t0 : 0;
    if (cl && toppled !== cl.c) {
      while (stacked.length < cl.h) {
        const k = stacked.length + 1;
        const m = makeCoin(cl.gold.some(([g]) => g === k) ? goldenMat : coinMat);
        const spotK = coinSpot(cl.c, k);
        m.position.set(spotK.x, COIN_H * (k - 0.5), spotK.z);
        m.rotation.y = spotK.r;
        tower.add(m);
        stacked.push(m);
      }
    }
    // The tower sways as much as the next coin is likely to topple it.
    const nextMood = cl && cl.fell < 0 ? cl.moods[cl.h] ?? 1 : 0;
    const amp = cl && cl.fell < 0 && ms >= cl.bet ? [0.004, 0.012, 0.03][nextMood]! * (1 + cl.h * 0.12) : 0;
    tower.rotation.z = Math.sin(now / (nextMood === 2 ? 140 : 260)) * amp;
    tower.rotation.x = Math.cos(now / (nextMood === 2 ? 170 : 330)) * amp * 0.7;
    // The next coin: over the tower, turning, in its mood's light; dropping onto it as it is due.
    const topY = BASE_Y + COIN_H * (cl?.h ?? 0);
    if (cl && cl.fell < 0 && ms >= cl.bet - 600) {
      dropping.visible = true;
      dropping.material = moodMats[nextMood]!;
      const until = cl.next - ms;
      const fall = Math.max(0, Math.min(1, 1 - until / DROP_MS));
      const hover = topY + 2.6 + Math.sin(now / 300) * 0.12;
      dropping.position.set(0, hover + (topY + COIN_H / 2 - hover) * fall * fall, 0);
      dropping.rotation.set(fall < 1 ? 0.3 * (1 - fall) : 0, now / 400, 0);
    } else dropping.visible = false;

    // What happened since the last frame.
    for (const e of events.splice(0)) {
      if (e.kind === 'land') {
        clinkSound(e.h, 0, e.gold ? 0.2 : 0.13);
        if (e.gold) { fanfare(); glowUntil = now + 1500; burst(new THREE.Vector3(0, topY + 0.3, 0), 60, now, 7); }
      } else if (e.kind === 'fell') { crash(); topple(now); toppled = cl?.c ?? 0; shake = 0.6; }
      else if (e.kind === 'top') { fanfare(); pour(14); burst(new THREE.Vector3(0, topY + 0.3, 0), 140, now, 9); glowUntil = now + 2500; }
      else if (e.kind === 'grab') {
        const won = e.won > 0 ? `+${chipsText(e.won)}` : '';
        pop(e.who, won || 'Off', e.who === me ? '#ffd84a' : '#ffffff', now);
        if (e.who === me) pour(Math.min(12, 3 + e.h)); else clinkSound(4, 0, 0.05);
      } else if (e.kind === 'gilded') { pop(e.who, `+${chipsText(e.amount)}`, '#ffb000', now); if (e.who === me) pour(10); }
      else if (e.kind === 'flip') {
        pop(e.who, e.win ? `×2 +${chipsText(e.amount)}` : `−${chipsText(e.amount)}`, e.win ? '#3ddc84' : '#ff4d4d', now);
        if (e.who === me) { if (e.win) { tone(660, 0, 0.15, 0.12, 'triangle'); tone(990, 0.1, 0.25, 0.12, 'triangle'); pour(6); } else { tone(330, 0, 0.2, 0.12, 'triangle'); tone(220, 0.12, 0.35, 0.12, 'triangle'); } }
      } else if (e.kind === 'interest') { pop(me, `🐷 +${chipsText(e.amount)}`, '#ff9ecb', now); pour(3); }
      else if (e.kind === 'beep') thump(2, true);
      else if (e.kind === 'go') { thump(5, true); thump(3, true); }
      else if (e.kind === 'won') { fanfare(); pour(16); }
    }
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i]!;
      if (now > f.until) { scene.remove(f.mesh); flying.splice(i, 1); continue; }
      f.v.y -= 22 * s;
      f.mesh.position.addScaledVector(f.v, s);
      if (f.mesh.position.y < f.floor && Math.hypot(f.mesh.position.x, f.mesh.position.z) < TABLE_R) { f.mesh.position.y = f.floor; f.v.y = Math.abs(f.v.y) * 0.35; f.v.x *= 0.7; f.v.z *= 0.7; f.spin.multiplyScalar(0.7); }
      f.mesh.rotation.x += f.spin.x * s;
      f.mesh.rotation.z += f.spin.y * s;
    }
    // The pot: more coins in the heap the more it holds.
    const potNow = cl?.pot ?? 0;
    const heap = potNow <= 0 ? 0 : Math.min(potCoins.length, Math.max(1, Math.round(Math.log10(potNow) * 4)));
    potCoins.forEach((m, i) => { m.visible = i < heap; });
    glow.intensity = now < glowUntil ? 60 * ((glowUntil - now) / 1500) : 0;
    glow.position.set(0, topY + 1, 0);

    // The camera: the tower big in the middle of what the controls leave free, back as far as its height and a narrow
    // screen want, the players behind it; shaken by a fall.
    const tall = (cl?.h ?? 0) * COIN_H;
    const d = (tall + 5) * (camera.aspect < 1 ? 2 : 1.35) + 3;
    const want = new THREE.Vector3(0, BASE_Y + tall * 0.5 + Math.sin(0.4) * d, Math.cos(0.4) * d);
    const wantLook = new THREE.Vector3(0, BASE_Y + tall * 0.6 + 1.2, -0.8);
    const k = 1 - Math.exp(-s * 3);
    camAt.lerp(want, k);
    lookAt.lerp(wantLook, k);
    shake = Math.max(0, shake - s);
    camera.position.set(camAt.x + (Math.random() - 0.5) * shake, camAt.y + (Math.random() - 0.5) * shake, camAt.z);
    camera.lookAt(lookAt);
    // Lite, a frame every LITE_MS at most: the page's own work (and a test's) gets a turn between them.
    if (renderer && (!lite || now - lastRender >= LITE_MS)) { renderer.render(scene, camera); lastRender = now; }
  }
  let lastRender = 0;

  // The HUD, as the match goes.
  let hudKey = '';
  let panelWas = true;
  function updateHud(now: number): void {
    const name = (who: string | null) => {
      if (who === null) return null;
      if (who === myWho) return 'You';
      const o = [...others.values()].find((x) => whoOf(x.key) === who);
      return o ? opts.faceOf(o.key).name : 'Someone';
    };
    const cl = climb;
    const ms = cl ? now - cl.t0 : 0;
    const iWatch = watching();
    const sat = seated();
    const final = round.phase === 'play' && cl?.c === CLIMBS;
    let text = '';
    if (round.phase === 'wait') text = heard(now).length === 0 ? 'Practice · waiting for a friend to join' : 'Next match starts soon';
    else if (round.phase === 'count') text = iWatch ? 'You are in the next match' : String(Math.max(1, Math.ceil((COUNT_MS - (now - round.since)) / 1000)));
    else if (round.phase === 'play' && iWatch) text = 'You are in the next match';
    else if (round.phase === 'over') { const w = name(round.winner); text = w === null ? 'Nobody wins' : w === 'You' ? '🏆 You win!' : `🏆 ${w} wins!`; }
    else if (cl && ms < cl.bet) text = `${final ? 'Last climb! Wins ×' + raiseOf(CLIMBS).toFixed(1) : `Climb ${cl.c} of ${CLIMBS}`} · stakes close in ${Math.max(1, Math.ceil((cl.bet - ms) / 1000))}`;
    else if (cl && cl.fell >= 0) text = cl.h >= TOP ? `🏆 To the top! ${multText(MULTS[TOP]!)}` : `💥 It fell at ${multText(MULTS[cl.h + 1] ?? MULTS[TOP]!)}`;
    // The board: everyone's chips, most first, and where they are on the tower.
    const rows = [
      { key: me, who: myWho, chips: worth(seat), at: seat.at, c: seat.c },
      ...heard(now).filter((o) => round.phase === 'wait' || o.frame.r === round.n || round.phase === 'over').map((o) => ({ key: o.key, who: whoOf(o.key), chips: o.frame.ch + (o.frame.a === RIDING ? o.frame.st : 0), at: o.frame.a, c: o.frame.c })),
    ];
    const scored = round.phase === 'over' && round.scores ? rows.map((r) => ({ ...r, chips: round.scores?.[r.who] ?? r.chips })) : rows;
    scored.sort((a, b) => b.chips - a.chips);
    const where = (at: number, c: number) => (!cl || c !== cl.c ? '' : at === RIDING ? ' 🧗' : at === FELL ? ' 💥' : at >= 0 ? ` ✋${multText(MULTS[at]!)}` : '');
    const boardRows = round.phase === 'count' ? [] : scored.map((r) => `${r.key === me ? 'You' : name(r.who) ?? 'Someone'} ${chipsText(r.chips)}${where(r.at, r.c)}`);
    const resultRows = round.phase === 'over' && round.scores ? Object.entries(round.scores).sort((a, b) => b[1] - a[1]).map(([who, v], i) => `${i + 1}. ${name(who) ?? 'Someone'} ${chipsText(v)}`) : [];
    // The tower: what it pays now, and the next coin's odds.
    const odds = cl ? nextOdds(cl) : null;
    const moodNow = cl ? cl.moods[cl.h] ?? 1 : 1;
    const multLine = cl && round.phase !== 'over' && round.phase !== 'count' ? multText(MULTS[cl.h]!) : '';
    const oddsLine = odds !== null && cl && ms >= cl.bet - 600 ? `next coin ${MOOD_NAMES[moodNow]} · ${odds}% to fall` : '';
    // What I can do.
    let actText = '', actOn = false, actKind = 'none';
    if (sat && cl && seat.c === cl.c) {
      if (canGrab(now)) { actText = `Grab ${multText(MULTS[cl.h]!)} · ${chipsText(payout(seat.stake, cl.h, seat.levels, seat.c))}`; actOn = true; actKind = 'grab'; }
      else if (canFlip(seat)) { actText = `Double or nothing  ${chipsText(flipStake(seat))}`; actOn = true; actKind = 'flip'; }
      else if (seat.at === RIDING && ms < cl.bet) { actText = `${chipsText(seat.stake)} on the tower`; actKind = 'wait'; }
      else if (seat.at === RIDING) { actText = '…'; actKind = 'wait'; }
      else if (ms < cl.bet) { actText = `Stake ${SHARE_LABELS[seat.share]}: ${chipsText(Math.floor(seat.chips / seat.share))}`; actKind = 'wait'; }
      else if (seat.at === FELL) { actText = `Lost ${chipsText(seat.stake)}`; actKind = 'lost'; }
      else if (seat.at >= 0 && seat.flip !== 0) { actText = seat.flip === 1 ? 'Doubled!' : 'Lost the double'; actKind = seat.flip === 1 ? 'won' : 'lost'; }
      else if (seat.at >= 0) { actText = `Grabbed ${multText(MULTS[seat.at]!)}`; actKind = 'won'; }
      else actText = 'Sitting this one out';
    } else if (sat && !cl) actText = '';
    const key = [text, boardRows.join(','), resultRows.join(','), multLine, oddsLine, moodNow, actText, actOn, actKind, chipsText(seat.chips), seat.share, seat.levels.join(','), cl?.pot ?? 0, sat, round.phase].join('|');
    if (key === hudKey) return;
    hudKey = key;
    banner.textContent = text;
    banner.classList.toggle('big', round.phase === 'count' || round.phase === 'over' || (!!cl && cl.fell >= 0 && round.phase !== 'wait'));
    board.replaceChildren(...boardRows.map((r) => { const li = document.createElement('li'); li.textContent = r; return li; }));
    results.replaceChildren(...resultRows.map((r) => { const li = document.createElement('li'); li.textContent = r; return li; }));
    pot.textContent = cl && cl.pot >= 1 ? `Pot ${chipsText(cl.pot)}` : '';
    mult.textContent = multLine;
    oddsEl.textContent = oddsLine;
    oddsEl.style.color = MOOD_COLOURS[moodNow]!;
    gauge.hidden = !multLine && !pot.textContent;
    panel.hidden = !sat || round.phase === 'over';
    chipsLine.textContent = `${chipsText(seat.chips)} chips`;
    for (const { s, b } of shareButtons) {
      b.textContent = SHARE_LABELS[s];
      b.classList.toggle('on', seat.share === s);
      b.title = `Stake ${SHARE_LABELS[s] === 'All' ? 'all' : SHARE_LABELS[s]} of your chips each climb (${s === 4 ? 1 : s === 2 ? 2 : 3})`;
    }
    if (panelWas !== panel.hidden) { panelWas = panel.hidden; resize(); }
    act.textContent = actText;
    act.disabled = !actOn;
    act.dataset['kind'] = actKind;
    act.hidden = !actText;
    for (const { u, b } of shopButtons) {
      const cost = costOf(seat.levels, u);
      const lv = seat.levels[UPGRADES.indexOf(u)] ?? 0;
      b.textContent = '';
      const icon = el('span', 'clink-icon', SHOP[u].icon);
      const price = el('span', 'clink-price', cost === null ? 'max' : chipsText(cost));
      const dots = el('span', 'clink-level', '●'.repeat(lv) + '○'.repeat(SHOP[u].costs.length - lv));
      b.append(icon, price, dots);
      b.disabled = cost === null || seat.chips < cost;
      b.title = `${SHOP[u].name}: ${cost === null ? `${SHOP[u].what(lv)} (all bought)` : `${SHOP[u].what(lv + 1)}${lv ? ` (now ${SHOP[u].what(lv).toLowerCase()})` : ''}`}`;
      b.setAttribute('aria-label', `${SHOP[u].name}${cost === null ? '' : `, ${chipsText(cost)} chips`}`);
    }
  }

  let frame = 0;
  let lastDraw = performance.now();
  // The governor: a device that draws fewer than about 25 frames a second over its first 90 goes lite.
  const frameTimes: number[] = [];
  const governor = (dt: number) => {
    if (lite || frameTimes.length >= 90) return;
    frameTimes.push(dt);
    if (frameTimes.length === 90 && [...frameTimes].sort((a, b) => a - b)[45]! > 40) goLite();
  };
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    step(now);
    governor(now - lastDraw);
    draw(now, Math.min(100, now - lastDraw));
    updateHud(now);
    lastDraw = now;
  };
  frame = requestAnimationFrame(loop);
  // A hidden tab draws nothing, but its seat is still followed and sent, and its tower run if it leads.
  const ticker = setInterval(() => { const now = performance.now(); if (now - last > 150) { step(now); updateHud(now); } }, 150);
  host.focus({ preventScroll: true });

  if (exposeHooks) {
    const w = window as unknown as { __daveGame?: () => ClinkView; __daveClinkRig?: (v: number | null) => void };
    w.__daveClinkRig = (v) => { rig = v; };
    w.__daveGame = (): ClinkView => {
      const now = performance.now();
      const cl = climb;
      return {
        game: 'clink', phase: round.phase, round: round.n, leader, playing: playing !== 0, connected: links.connected().length,
        climb: cl ? { c: cl.c, h: cl.h, fell: cl.fell >= 0, odds: nextOdds(cl), open: now - cl.t0 < cl.bet, pot: Math.floor(cl.pot), gold: cl.gold.length } : null,
        me: { chips: Math.floor(seat.chips), share: seat.share, stake: seat.stake, at: seat.at, won: seat.won, flip: seat.flip, levels: [...seat.levels] },
        others: heard(now).map((o) => ({ key: o.key, chips: o.frame.ch, at: o.frame.a, c: o.frame.c })),
        scores: round.scores ?? null, winner: round.winner, wins: { ...round.wins },
      };
    };
  }

  return () => {
    cancelAnimationFrame(frame);
    clearInterval(ticker);
    offFrames();
    sizer.disconnect();
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('pointerdown', onPointerDown);
    for (const s of shown.values()) disposeShown(s);
    for (const o of owned) o.dispose();
    envMap?.dispose();
    renderer?.forceContextLoss();
    renderer?.dispose();
    renderer?.domElement.remove();
    hud.remove();
    if (exposeHooks) {
      const w = window as unknown as { __daveGame?: unknown; __daveClinkRig?: unknown };
      delete w.__daveGame;
      delete w.__daveClinkRig;
    }
  };
}
