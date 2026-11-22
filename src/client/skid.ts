// Skid on screen (core/skid.ts): the track, my kart and everyone else's as their apps say, the boxes, pads and slicks,
// in three.js, seen from behind my kart; the keys, a stick and buttons on a touch screen, the sounds; the race, run by
// its leader (core/rounds.ts). Loaded only once a friend plays it (client/Game.tsx).
import * as THREE from 'three';
import {
  BOXES, BOX_BACK_MS, BOX_RADIUS, COUNT_MS, LAPS, PADS, PAD_LENGTH, SLICK_LIFE_MS, SLICK_RADIUS, TRACK, TRACK_WIDTH,
  advance, boost, boxAt, bump, drive, itemOf, kartAt, kartFrame, locate, onPad, parseFrame, pointAt, spin, standings,
  type Controls, type Counted, type Item, type Kart, type KartFrame, type SkidView,
} from '../core/skid';
import { firstRound, leaderOf, roundFrame, roundOf, whoOf, type Round } from '../core/rounds';
import type { GameLinks } from './gamelinks';
import { exposeHooks } from './hooks';
import { isTyping, nameTag, skin, threeColourOf, thump, type Face } from './gamekit';

const SEND_MS = 50;
const ROUND_SEND_MS = 250;
const HEARD_MS = 2500;
const MAX_STEP_S = 0.05;
const ITEM_ICONS: Record<Item, string> = { turbo: '🚀', slick: '🛢️' };
/** Kart colours told apart at a glance, one each in a race's order; outside a race, each player's own (client/gamekit.ts). */
const PALETTE = ['#e5484d', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

type Other = { key: string; frame: KartFrame; at: number };

const ordinal = (n: number): string => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const clock = (ms: number): string => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };

/** A canvas texture drawn by `draw` on a `w` × `h` canvas. */
function painted(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A small seeded random, so the scenery stands in the same place on every screen. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Skid, in `host`, for me (`me`, my key), over `links` to the other players. Returns how to stop it. */
export function mountSkid(host: HTMLElement, opts: { me: string; links: GameLinks; faceOf: (key: string) => Face }): () => void {
  const { me, links } = opts;
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  let kart: Kart = kartAt(0);
  /** The race I am in; 0 while I watch one or none is on. */
  let playing = 0;
  let round: Round = firstRound(performance.now());
  const roundSeq = new Map<string, number>();
  let sentRound = 0;
  let leader: string | null = me;
  let controls: Controls = { throttle: 0, steer: 0, drift: false };
  let itemAsked = false;
  let last = performance.now();
  let lastSent = 0;
  let lastRoundSent = 0;
  /** Boxes I took, and when: each app's own. */
  const boxGone = new Map<number, number>();
  /** My last slick, as my frames carry it; the others' as theirs do, when first seen here; the ones my kart hit. */
  let mySlick: [number, number, number] | null = null;
  const slicksSeen = new Map<string, { x: number; z: number; seen: number }>();
  const slicksHit = new Set<string>();
  const events: { kind: 'bump' | 'boost' | 'spin' | 'item' | 'beep' | 'go'; at?: { x: number; z: number } }[] = [];
  let lastBeep = -1;

  const watching = () => playing === 0 && (round.phase === 'count' || round.phase === 'play');
  // As #rrggbb, which three.js reads (it does not read gamekit's hsl() without commas).
  const colourFor = (key: string): string => { const i = round.players.indexOf(whoOf(key)); return i >= 0 ? PALETTE[i % PALETTE.length]! : `#${threeColourOf(key).getHexString()}`; };
  const raceMs = (now: number) => (round.phase === 'play' ? now - round.since : 0);

  const took = (next: Round) => {
    const was = round;
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    if (next.phase === 'count') {
      const i = next.players.indexOf(myWho);
      playing = i >= 0 ? next.n : 0;
      kart = kartAt(Math.max(0, i));
      boxGone.clear();
      mySlick = null;
      slicksSeen.clear();
      slicksHit.clear();
    } else if (next.phase === 'play') {
      if (playing !== next.n) playing = 0; // came in after the countdown: this race is watched
      else events.push({ kind: 'go' });
    } else if (next.phase === 'wait') {
      playing = 0;
      kart = { ...kartAt(0), finished: null };
    } else if (next.phase === 'over' && next.winner === myWho) {
      thump(6, true);
    }
  };

  const heard = (now: number): Other[] => [...others.values()].filter((o) => now - o.at < HEARD_MS);

  const offFrames = links.listen((from, data) => {
    const f = parseFrame(data);
    if (!f) return;
    const now = performance.now();
    if (f.k === 'k') {
      others.set(from, { key: from, frame: f, at: now });
      // A slick of this race only: a frame sent before its dropper took the countdown still carries the last race's.
      if (f.s && round.phase === 'play' && f.r === round.n && f.r > 0) { const id = `${from}:${f.s[2]}`; if (!slicksSeen.has(id)) slicksSeen.set(id, { x: f.s[0], z: f.s[1], seen: now }); }
      return;
    }
    if (from !== leader || f.q <= (roundSeq.get(from) ?? -1)) return;
    roundSeq.set(from, f.q);
    const next = roundOf(f, now);
    took(next.n === round.n && next.phase === round.phase && Math.abs(next.since - round.since) < 150 ? { ...next, since: round.since } : next);
  });

  function step(now: number): void {
    let dt = (now - last) / 1000;
    last = now;
    const around = heard(now);
    leader = leaderOf([{ key: me, n: round.n }, ...around.map((o) => ({ key: o.key, n: o.frame.n }))]);
    if (leader === me) {
      const counted: Counted[] = [{ who: myWho, n: playing, known: round.n, finished: playing ? kart.finished : null }, ...around.map((o) => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n, finished: o.frame.f >= 0 ? o.frame.f : null }))];
      const next = advance(round, now, counted);
      if (next !== round) { took(next); lastRoundSent = 0; }
      if (now - lastRoundSent >= ROUND_SEND_MS) { sentRound = Math.max(Date.now(), sentRound + 1); links.broadcast(JSON.stringify(roundFrame(round, now, sentRound))); lastRoundSent = now; }
    }
    // The countdown: everyone on the grid; beeps for the last three seconds.
    if (round.phase === 'count' && !watching()) {
      const left = Math.ceil((COUNT_MS - (now - round.since)) / 1000);
      if (left !== lastBeep && left <= 3 && left >= 1) { lastBeep = left; events.push({ kind: 'beep' }); }
    }
    const frozen = watching() || round.phase === 'count';
    if (!frozen) {
      const race = raceMs(now);
      while (dt > 0) {
        const h = Math.min(dt, MAX_STEP_S / 3);
        dt -= h;
        const was = kart;
        kart = drive(kart, controls, h, now, race, round.phase === 'play');
        if (kart.drift === 0 && was.drift !== 0 && kart.boostUntil > was.boostUntil) events.push({ kind: 'boost' });
      }
      const where = locate(kart.x, kart.z);
      if (onPad(where.progress, where.side) && kart.boostUntil < now + 200) { kart = boost(kart, now, 900); events.push({ kind: 'boost' }); }
      // Item boxes: mine to take, back after a while.
      for (let i = 0; i < BOXES.length; i++) {
        const gone = boxGone.get(i);
        if (gone !== undefined && now - gone < BOX_BACK_MS) continue;
        const b = boxAt(i);
        if (Math.hypot(b.x - kart.x, b.z - kart.z) < BOX_RADIUS) { boxGone.set(i, now); if (!kart.item) { kart = { ...kart, item: itemOf(Math.random()) }; events.push({ kind: 'item' }); } }
      }
      if (itemAsked && kart.item) {
        if (kart.item === 'turbo') { kart = boost(kart, now, 1300); events.push({ kind: 'boost' }); }
        else mySlick = [Math.round((kart.x - Math.cos(kart.h) * 2.8) * 100) / 100, Math.round((kart.z - Math.sin(kart.h) * 2.8) * 100) / 100, Math.max(Date.now(), (mySlick?.[2] ?? 0) + 1)];
        kart = { ...kart, item: null };
      }
      // Others' slicks, and bumps with their karts.
      for (const [id, s] of slicksSeen) {
        if (!slicksHit.has(id) && now >= kart.spinUntil && Math.hypot(s.x - kart.x, s.z - kart.z) < SLICK_RADIUS) { slicksHit.add(id); kart = spin(kart, now); events.push({ kind: 'spin' }); }
      }
      for (const o of around) {
        if (round.phase === 'play' && o.frame.r !== playing) continue;
        const age = Math.min(0.25, (now - o.at) / 1000);
        const ox = o.frame.x + Math.cos(o.frame.h) * o.frame.v * age, oz = o.frame.z + Math.sin(o.frame.h) * o.frame.v * age;
        const b = bump(kart, { x: ox, z: oz });
        if (b !== kart && Math.abs(kart.v) > 4) events.push({ kind: 'bump', at: { x: ox, z: oz } });
        kart = b;
      }
    }
    // Slicks dry up, watched or not.
    for (const [id, s] of slicksSeen) if (now - s.seen > SLICK_LIFE_MS) slicksSeen.delete(id);
    if (mySlick && Date.now() - mySlick[2] > SLICK_LIFE_MS) mySlick = null;
    itemAsked = false;
    if (now - lastSent >= SEND_MS) {
      links.broadcast(JSON.stringify(kartFrame(kart, watching() ? 0 : playing, round.n, now, mySlick)));
      lastSent = now;
    }
  }

  // Keys while the game has the focus.
  const keys = new Set<string>();
  let touchControls: Controls | null = null;
  let driftHeld = false;
  const fromKeys = () => {
    if (touchControls) { controls = { ...touchControls, drift: driftHeld }; return; }
    const throttle = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0);
    const steer = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    controls = { throttle, steer, drift: keys.has('Space') || driftHeld };
  };
  const DRIVE_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']);
  const ITEM_KEYS = new Set(['KeyE', 'ShiftLeft', 'ShiftRight', 'Enter']);
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (DRIVE_KEYS.has(e.code)) { keys.add(e.code); fromKeys(); e.preventDefault(); }
    else if (ITEM_KEYS.has(e.code)) { if (!e.repeat) itemAsked = true; e.preventDefault(); }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (keys.delete(e.code)) fromKeys(); };
  const onBlur = () => { keys.clear(); fromKeys(); };
  host.tabIndex = 0;
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  host.addEventListener('blur', onBlur);

  // The HUD.
  const hud = document.createElement('div');
  hud.className = 'bonk-hud skid-hud';
  const banner = document.createElement('div');
  banner.className = 'bonk-banner';
  const stats = document.createElement('div');
  stats.className = 'skid-stats';
  const itemBox = document.createElement('div');
  itemBox.className = 'skid-item';
  const map = document.createElement('canvas');
  map.className = 'skid-map';
  map.width = 150; map.height = 120;
  const results = document.createElement('ol');
  results.className = 'skid-results';
  const help = document.createElement('div');
  help.className = 'bonk-help';
  help.textContent = 'Arrows or WASD to drive · hold Space to drift, let go to boost · E or Shift for an item';
  const driftButton = document.createElement('button');
  driftButton.type = 'button';
  driftButton.className = 'bonk-dash skid-drift';
  driftButton.textContent = 'Drift';
  const itemButton = document.createElement('button');
  itemButton.type = 'button';
  itemButton.className = 'bonk-dash skid-use';
  itemButton.textContent = 'Item';
  const stick = document.createElement('div');
  stick.className = 'bonk-stick';
  hud.append(banner, stats, itemBox, map, results, help, driftButton, itemButton, stick);
  host.append(hud);
  driftButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); driftHeld = true; fromKeys(); });
  const driftUp = () => { if (driftHeld) { driftHeld = false; fromKeys(); } };
  driftButton.addEventListener('pointerup', driftUp);
  driftButton.addEventListener('pointercancel', driftUp);
  driftButton.addEventListener('pointerleave', driftUp);
  itemButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); itemAsked = true; });

  // On a touch screen: a stick where the finger goes down; it drives forward, to the side it steers, pulled back it brakes.
  let touch: { id: number; x: number; y: number } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    host.focus({ preventScroll: true });
    if (e.pointerType === 'mouse') return;
    host.classList.add('bonk-touch');
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    const r = host.getBoundingClientRect();
    stick.style.left = `${e.clientX - r.left}px`;
    stick.style.top = `${e.clientY - r.top}px`;
    stick.classList.add('on');
    touchControls = { throttle: 1, steer: 0, drift: false };
    fromKeys();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = (e.clientX - touch.x) / 45, dy = (e.clientY - touch.y) / 45;
    touchControls = { throttle: dy > 0.6 ? -1 : 1, steer: Math.max(-1, Math.min(1, dx)), drift: false };
    fromKeys();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    touch = null;
    touchControls = null;
    stick.classList.remove('on');
    fromKeys();
  };
  host.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

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
  const sky = new THREE.Color('#9fd8ff');
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 70, 190);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);
  scene.add(new THREE.HemisphereLight('#ffffff', '#4d7a3a', 1.6));
  const sun = new THREE.DirectionalLight('#fff1d6', 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 });
  scene.add(sun, sun.target);

  const owned: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => { owned.push(x); return x; };
  const grass = new THREE.Mesh(keep(new THREE.PlaneGeometry(600, 600)), keep(new THREE.MeshStandardMaterial({ color: '#79c26a', roughness: 1 })));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.02;
  grass.receiveShadow = true;
  scene.add(grass);

  // The road: a ribbon along the track's middle, kerbs red and white along both edges.
  const n = TRACK.points.length;
  const normals = TRACK.points.map((_, i) => {
    const a = TRACK.points[(i - 1 + n) % n]!, b = TRACK.points[(i + 1) % n]!;
    const d = Math.atan2(b.z - a.z, b.x - a.x);
    return { x: Math.sin(d), z: -Math.cos(d) }; // left of the way it goes (core/skid.ts, `gridAt`)
  });
  const ribbon = (inner: number, outer: number, colours: (i: number) => THREE.Color | null, y: number): THREE.BufferGeometry => {
    const pos: number[] = [], col: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const c = colours(i);
      const p = TRACK.points[i]!, q = TRACK.points[j]!, m = normals[i]!, o = normals[j]!;
      const quad = (side: 1 | -1) => {
        const a0 = { x: p.x + m.x * inner * side, z: p.z + m.z * inner * side }, a1 = { x: p.x + m.x * outer * side, z: p.z + m.z * outer * side };
        const b0 = { x: q.x + o.x * inner * side, z: q.z + o.z * inner * side }, b1 = { x: q.x + o.x * outer * side, z: q.z + o.z * outer * side };
        for (const v of [a0, a1, b1, a0, b1, b0]) { pos.push(v.x, y, v.z); if (c) col.push(c.r, c.g, c.b); }
      };
      quad(1);
      if (inner > 0) quad(-1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return keep(g);
  };
  const road = new THREE.Mesh(ribbon(-TRACK_WIDTH / 2, TRACK_WIDTH / 2, () => null, 0), keep(new THREE.MeshStandardMaterial({ color: '#4b4f58', roughness: 0.85, side: THREE.DoubleSide })));
  road.receiveShadow = true;
  const red = new THREE.Color('#e5484d'), white = new THREE.Color('#f5f5f5');
  const kerbs = new THREE.Mesh(ribbon(TRACK_WIDTH / 2, TRACK_WIDTH / 2 + 0.9, (i) => (Math.floor(i / 2) % 2 ? red : white), 0.02), keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide })));
  kerbs.receiveShadow = true;
  scene.add(road, kerbs);

  // The start line, checkered, and a gantry over it.
  const start = pointAt(0);
  const line = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, TRACK_WIDTH)), keep(new THREE.MeshStandardMaterial({ map: keep(painted(32, 160, (g) => { for (let y = 0; y < 10; y++) for (let x = 0; x < 2; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fff'; g.fillRect(x * 16, y * 16, 16, 16); } })), roughness: 0.7 })));
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = -start.dir;
  line.position.set(start.x, 0.03, start.z);
  scene.add(line);
  const post = keep(new THREE.BoxGeometry(0.5, 6, 0.5));
  const postMat = keep(new THREE.MeshStandardMaterial({ color: '#333a44' }));
  for (const side of [1, -1]) {
    const p = new THREE.Mesh(post, postMat);
    p.position.set(start.x + Math.sin(start.dir) * (TRACK_WIDTH / 2 + 1.2) * side, 3, start.z - Math.cos(start.dir) * (TRACK_WIDTH / 2 + 1.2) * side);
    p.castShadow = true;
    scene.add(p);
  }
  const banner3d = new THREE.Mesh(keep(new THREE.BoxGeometry(TRACK_WIDTH + 3, 1.4, 0.3)), keep(new THREE.MeshStandardMaterial({ map: keep(painted(512, 64, (g) => { for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fff'; g.fillRect(x * 16, y * 16, 16, 16); } })) })));
  banner3d.position.set(start.x, 6, start.z);
  banner3d.rotation.y = -start.dir + Math.PI / 2;
  scene.add(banner3d);

  // Boost pads: yellow chevrons along the road.
  const padTex = keep(painted(128, 256, (g) => {
    g.fillStyle = '#2a2d33'; g.fillRect(0, 0, 128, 256);
    g.strokeStyle = '#ffd23f'; g.lineWidth = 18; g.lineCap = 'round';
    for (let y = 40; y < 256; y += 80) { g.beginPath(); g.moveTo(20, y + 40); g.lineTo(64, y); g.lineTo(108, y + 40); g.stroke(); }
  }));
  for (const p of PADS) {
    const at = pointAt((p + PAD_LENGTH / 2) * TRACK.length);
    const pad = new THREE.Mesh(keep(new THREE.PlaneGeometry(TRACK_WIDTH - 3, PAD_LENGTH * TRACK.length)), keep(new THREE.MeshStandardMaterial({ map: padTex, emissive: '#ffb000', emissiveIntensity: 0.35, roughness: 0.6 })));
    pad.rotation.x = -Math.PI / 2;
    pad.rotation.z = -at.dir - Math.PI / 2;
    pad.position.set(at.x, 0.04, at.z);
    scene.add(pad);
  }

  // Item boxes: turning cubes with a question mark.
  const boxTex = keep(painted(128, 128, (g) => {
    const grd = g.createLinearGradient(0, 0, 128, 128);
    grd.addColorStop(0, '#7c5cff'); grd.addColorStop(0.5, '#38bdf8'); grd.addColorStop(1, '#34d399');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#fff'; g.font = 'bold 96px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 64, 70);
  }));
  const boxGeo = keep(new THREE.BoxGeometry(1.4, 1.4, 1.4));
  const boxMat = keep(new THREE.MeshStandardMaterial({ map: boxTex, transparent: true, opacity: 0.9, emissive: '#2a1a66', emissiveIntensity: 0.4 }));
  const boxes = BOXES.map((_, i) => { const m = new THREE.Mesh(boxGeo, boxMat); const b = boxAt(i); m.position.set(b.x, 1.2, b.z); m.castShadow = true; scene.add(m); return m; });

  // Scenery: trees and rocks off the road, the same on every screen.
  const rand = seeded(7);
  const trunk = keep(new THREE.CylinderGeometry(0.3, 0.4, 1.6, 7));
  const crown = keep(new THREE.ConeGeometry(1.7, 3.8, 7));
  const rock = keep(new THREE.DodecahedronGeometry(1.1));
  const wood = keep(new THREE.MeshStandardMaterial({ color: '#7a4e32' }));
  const leaves = keep(new THREE.MeshStandardMaterial({ color: '#2f8a4b', flatShading: true }));
  const stone = keep(new THREE.MeshStandardMaterial({ color: '#9aa1a8', flatShading: true }));
  for (let placed = 0, tries = 0; placed < 140 && tries < 2000; tries++) {
    const x = (rand() - 0.5) * 220, z = (rand() - 0.5) * 200;
    if (Math.abs(locate(x, z).side) < TRACK_WIDTH / 2 + 4) continue;
    placed++;
    const s = 0.7 + rand() * 0.8;
    if (rand() < 0.8) {
      const t = new THREE.Mesh(trunk, wood), c = new THREE.Mesh(crown, leaves);
      t.position.set(x, 0.8 * s, z); t.scale.setScalar(s);
      c.position.set(x, (1.6 + 1.9) * s, z); c.scale.setScalar(s);
      t.castShadow = c.castShadow = true;
      scene.add(t, c);
    } else {
      const r = new THREE.Mesh(rock, stone);
      r.position.set(x, 0.4 * s, z); r.scale.set(s * 1.4, s, s * 1.2); r.rotation.y = rand() * 6;
      r.castShadow = true;
      scene.add(r);
    }
  }

  // Slicks: dark glossy puddles.
  const slickGeo = keep(new THREE.CircleGeometry(SLICK_RADIUS, 24));
  const slickMat = keep(new THREE.MeshStandardMaterial({ color: '#15161a', roughness: 0.1, metalness: 0.6 }));
  const slickMeshes = new Map<string, THREE.Mesh>();

  // Karts.
  type Shown = { group: THREE.Group; body: THREE.Group; head: THREE.Mesh; flame: THREE.Mesh; sparks: THREE.Mesh; face: string; x: number; z: number; h: number; spinAngle: number; wheels: THREE.Mesh[] };
  const shown = new Map<string, Shown>();
  const chassis = keep(new THREE.BoxGeometry(2.4, 0.55, 1.5));
  const nose = keep(new THREE.BoxGeometry(0.8, 0.35, 1.2));
  const wheelGeo = keep(new THREE.CylinderGeometry(0.42, 0.42, 0.35, 14));
  const wheelMat = keep(new THREE.MeshStandardMaterial({ color: '#1b1c20', roughness: 0.8 }));
  const headGeo = keep(new THREE.SphereGeometry(0.62, 28, 20));
  const flameGeo = keep(new THREE.ConeGeometry(0.35, 1.6, 10));
  const flameMat = keep(new THREE.MeshBasicMaterial({ color: '#ffb02e', transparent: true, opacity: 0.85 }));
  const sparkGeo = keep(new THREE.SphereGeometry(0.22, 8, 6));
  const show = (key: string): Shown => {
    const f = opts.faceOf(key);
    const colour = colourFor(key);
    const id = `${f.name}\n${f.picture ?? ''}\n${colour}`;
    let s = shown.get(key);
    if (s && s.face === id) return s;
    if (s) { scene.remove(s.group); disposeKart(s); }
    const paint = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour), roughness: 0.35, metalness: 0.2 });
    const body = new THREE.Group();
    const c = new THREE.Mesh(chassis, paint); c.position.y = 0.55; c.castShadow = true;
    const nz = new THREE.Mesh(nose, paint); nz.position.set(1.35, 0.5, 0); nz.castShadow = true;
    const wheels = [[0.8, 0.8], [0.8, -0.8], [-0.8, 0.8], [-0.8, -0.8]].map(([x, z]) => { const w = new THREE.Mesh(wheelGeo, wheelMat); w.rotation.x = Math.PI / 2; w.position.set(x!, 0.42, z!); w.castShadow = true; return w; });
    const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({ map: skin(f, colour), roughness: 0.4 }));
    head.position.set(-0.25, 1.45, 0);
    // The face toward the front of the kart (gamekit's skin faces +z, the kart's front is +x).
    head.rotation.y = Math.PI / 2;
    head.castShadow = true;
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.rotation.z = Math.PI / 2;
    flame.position.set(-1.9, 0.6, 0);
    const sparks = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color: '#4cc9ff' }));
    body.add(c, nz, ...wheels, head, flame, sparks);
    const tag = nameTag(key === me ? 'You' : f.name, key === me);
    tag.position.y = 2.9;
    const group = new THREE.Group();
    group.add(body, tag);
    scene.add(group);
    s = { group, body, head, flame, sparks, face: id, x: 0, z: 0, h: 0, spinAngle: 0, wheels };
    shown.set(key, s);
    return s;
  };
  function disposeKart(s: Shown): void {
    s.group.traverse((o) => {
      const m = o as THREE.Mesh;
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { if (owned.includes(mat)) continue; (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose(); }
    });
  }

  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.className = 'bonk-canvas';
    host.prepend(renderer.domElement);
  } else {
    help.textContent = 'This browser cannot draw the game (no WebGL), but you are in it.';
  }
  const resize = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer?.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const sizer = new ResizeObserver(resize);
  sizer.observe(host);
  resize();

  const camAt = new THREE.Vector3(start.x - Math.cos(start.dir) * 10, 6, start.z - Math.sin(start.dir) * 10);
  const lookAt = new THREE.Vector3(start.x, 1, start.z);
  let camSet = false;

  function draw(now: number, dt: number): void {
    const keysShown = new Set<string>();
    const place = (key: string, x: number, z: number, h: number, v: number, drift: number, boosting: boolean, spun: boolean, charged: boolean) => {
      const s = show(key);
      keysShown.add(key);
      const ease = key === me ? 1 : 1 - Math.exp(-dt * 16);
      s.x += (x - s.x) * ease; s.z += (z - s.z) * ease;
      s.h += Math.atan2(Math.sin(h - s.h), Math.cos(h - s.h)) * (key === me ? 1 : ease);
      s.spinAngle = spun ? s.spinAngle + dt * 14 : s.spinAngle * Math.exp(-dt * 10);
      s.group.position.set(s.x, 0, s.z);
      s.group.rotation.y = -s.h;
      s.body.rotation.y = -(drift * 0.35) + s.spinAngle;
      s.body.rotation.x = drift * 0.08;
      for (const w of s.wheels) w.rotation.y += v * dt * 2;
      s.flame.visible = boosting;
      if (boosting) s.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);
      s.sparks.visible = drift !== 0;
      if (drift !== 0) { s.sparks.position.set(-1.3, 0.25, -drift * 0.9); (s.sparks.material as THREE.MeshBasicMaterial).color.set(charged ? '#ff7a1a' : '#4cc9ff'); s.sparks.scale.setScalar(0.7 + Math.random() * 0.6); }
      s.group.visible = true;
    };
    const iWatch = watching();
    if (!iWatch) place(me, kart.x, kart.z, kart.h, kart.v, kart.drift, now < kart.boostUntil, now < kart.spinUntil, kart.charge >= 0.7);
    for (const o of heard(now)) {
      if (round.phase !== 'wait' && round.phase !== 'over' && o.frame.r === 0) continue;
      const age = Math.min(0.25, (now - o.at) / 1000);
      const f = o.frame;
      place(o.key, f.x + Math.cos(f.h) * f.v * age, f.z + Math.sin(f.h) * f.v * age, f.h, f.v, f.d, f.b, f.sp, false);
    }
    for (const [key, s] of shown) if (!keysShown.has(key)) s.group.visible = false;

    for (let i = 0; i < boxes.length; i++) {
      const gone = boxGone.get(i);
      const b = boxes[i]!;
      b.visible = gone === undefined || now - gone >= BOX_BACK_MS;
      b.rotation.set(now / 900, now / 700, 0);
      b.position.y = 1.2 + Math.sin(now / 400 + i) * 0.15;
    }
    // Slicks: mine and the others', while they last.
    const live = new Map<string, { x: number; z: number }>();
    if (mySlick) live.set(`${me}:${mySlick[2]}`, { x: mySlick[0], z: mySlick[1] });
    for (const [id, s] of slicksSeen) live.set(id, s);
    for (const [id, s] of live) {
      if (!slickMeshes.has(id)) { const m = new THREE.Mesh(slickGeo, slickMat); m.rotation.x = -Math.PI / 2; m.position.set(s.x, 0.05, s.z); scene.add(m); slickMeshes.set(id, m); }
    }
    for (const [id, m] of slickMeshes) if (!live.has(id)) { scene.remove(m); slickMeshes.delete(id); }

    for (const e of events.splice(0)) {
      if (e.kind === 'bump') thump(4);
      else if (e.kind === 'boost') thump(3, true);
      else if (e.kind === 'spin') thump(8);
      else if (e.kind === 'item') thump(1, true);
      else if (e.kind === 'beep') thump(2, true);
      else if (e.kind === 'go') { thump(5, true); thump(3, true); }
    }

    // The camera: behind my kart, or the race's leader while I watch, eased; the sun's shadows follow it.
    let target: { x: number; z: number; h: number } | null = iWatch ? null : { x: kart.x, z: kart.z, h: kart.h };
    if (!target) {
      const first = standings(heard(now).filter((o) => o.frame.r === round.n).map((o) => ({ ...o, lap: o.frame.lap, progress: o.frame.p, next: o.frame.next, finished: o.frame.f >= 0 ? o.frame.f : null })))[0];
      target = first ? { x: first.frame.x, z: first.frame.z, h: first.frame.h } : { x: start.x, z: start.z, h: start.dir };
    }
    const back = Math.max(1, 1.1 / camera.aspect);
    const want = new THREE.Vector3(target.x - Math.cos(target.h) * 9 * back, 4.6 * back, target.z - Math.sin(target.h) * 9 * back);
    const wantLook = new THREE.Vector3(target.x + Math.cos(target.h) * 6, 1, target.z + Math.sin(target.h) * 6);
    const k = camSet ? 1 - Math.exp(-dt * 6) : 1;
    camAt.lerp(want, k);
    lookAt.lerp(wantLook, k);
    camSet = true;
    camera.position.copy(camAt);
    camera.lookAt(lookAt);
    sun.position.set(target.x - 20, 40, target.z + 15);
    sun.target.position.set(target.x, 0, target.z);
    renderer?.render(scene, camera);
  }

  // The HUD, as the race goes.
  const mapCtx = map.getContext('2d');
  const xs = TRACK.points.map((p) => p.x), zs = TRACK.points.map((p) => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const scale = Math.min((map.width - 16) / (maxX - minX), (map.height - 16) / (maxZ - minZ));
  const mx = (x: number) => 8 + (x - minX) * scale, mz = (z: number) => 8 + (z - minZ) * scale;
  let hudKey = '';
  function updateHud(now: number): void {
    const name = (who: string | null) => {
      if (who === null) return null;
      if (who === myWho) return 'You';
      const o = [...others.values()].find((x) => whoOf(x.key) === who);
      return o ? opts.faceOf(o.key).name : 'Someone';
    };
    const ms = now - round.since;
    const iWatch = watching();
    const racers = [...(iWatch ? [] : [{ key: me, lap: kart.lap, progress: kart.progress, next: kart.next, finished: kart.finished, x: kart.x, z: kart.z }]),
      ...heard(now).filter((o) => round.phase === 'wait' || o.frame.r === round.n).map((o) => ({ key: o.key, lap: o.frame.lap, progress: o.frame.p, next: o.frame.next, finished: o.frame.f >= 0 ? o.frame.f : null, x: o.frame.x, z: o.frame.z }))];
    const order = standings(racers);
    const place = order.findIndex((r) => r.key === me) + 1;
    let text: string;
    if (round.phase === 'wait') text = heard(now).length === 0 ? 'Waiting for a friend to join… drive around meanwhile' : 'Next race starts soon';
    else if (round.phase === 'count') text = iWatch ? 'You are in the next race' : String(Math.max(1, Math.ceil((COUNT_MS - ms) / 1000)));
    else if (round.phase === 'play') text = iWatch ? 'You are in the next race' : ms < 1000 ? 'GO!' : kart.finished !== null ? `Finished ${ordinal(place)}!` : kart.lap === LAPS && kart.next === 0 && kart.progress < 0.05 ? 'Final lap!' : '';
    else { const w = name(round.winner); text = w === null ? 'Nobody finished' : w === 'You' ? '🏁 You win!' : `🏁 ${w} wins!`; }
    const lapShown = Math.min(kart.lap, LAPS);
    const statLine = round.phase === 'play' && !iWatch ? `Lap ${lapShown}/${LAPS} · ${ordinal(place)} of ${order.length} · ${clock(kart.finished ?? ms)}` : '';
    const resultRows = round.phase === 'over' && round.scores ? Object.entries(round.scores).sort((a, b) => a[1] - b[1]).map(([who, t], i) => `${i + 1}. ${name(who) ?? 'Someone'} ${clock(t)}`) : [];
    const key = `${text}|${statLine}|${kart.item ?? ''}|${resultRows.join(',')}|${round.phase}`;
    if (key !== hudKey) {
      hudKey = key;
      banner.textContent = text;
      banner.classList.toggle('big', round.phase === 'count' || text === 'GO!' || round.phase === 'over' || text.startsWith('Finished'));
      stats.textContent = statLine;
      itemBox.textContent = kart.item ? ITEM_ICONS[kart.item] : '';
      itemBox.classList.toggle('full', kart.item !== null);
      results.replaceChildren(...resultRows.map((r) => { const li = document.createElement('li'); li.textContent = r; return li; }));
    }
    // The map: the track, and every kart on it.
    if (mapCtx) {
      mapCtx.clearRect(0, 0, map.width, map.height);
      mapCtx.lineWidth = 5; mapCtx.lineJoin = 'round'; mapCtx.strokeStyle = 'rgba(40,44,52,.85)';
      mapCtx.beginPath();
      TRACK.points.forEach((p, i) => (i === 0 ? mapCtx.moveTo(mx(p.x), mz(p.z)) : mapCtx.lineTo(mx(p.x), mz(p.z))));
      mapCtx.closePath(); mapCtx.stroke();
      for (const r of racers) {
        mapCtx.fillStyle = colourFor(r.key);
        mapCtx.beginPath(); mapCtx.arc(mx(r.x), mz(r.z), r.key === me ? 5 : 4, 0, Math.PI * 2); mapCtx.fill();
        if (r.key === me) { mapCtx.lineWidth = 2; mapCtx.strokeStyle = '#fff'; mapCtx.stroke(); }
      }
    }
  }

  let frame = 0;
  let lastDraw = performance.now();
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    step(now);
    draw(now, Math.min(0.1, (now - lastDraw) / 1000));
    updateHud(now);
    lastDraw = now;
  };
  frame = requestAnimationFrame(loop);
  // A hidden tab draws nothing, but its kart is still sent, so the race does not wait for it.
  const ticker = setInterval(() => { const now = performance.now(); if (now - last > 200) { step(now); updateHud(now); } }, 200);
  host.focus({ preventScroll: true });

  if (exposeHooks) {
    (window as unknown as { __daveGame?: () => SkidView }).__daveGame = (): SkidView => {
      const now = performance.now();
      const racers = [{ key: me, lap: kart.lap, progress: kart.progress, next: kart.next, finished: kart.finished }, ...heard(now).filter((o) => round.phase === 'wait' || o.frame.r === round.n).map((o) => ({ key: o.key, lap: o.frame.lap, progress: o.frame.p, next: o.frame.next, finished: o.frame.f >= 0 ? o.frame.f : null }))];
      return {
        game: 'skid', phase: round.phase, round: round.n, leader, playing: playing !== 0, connected: links.connected().length,
        me: { x: kart.x, z: kart.z, v: kart.v, lap: kart.lap, progress: kart.progress, finished: kart.finished, item: kart.item, spun: now < kart.spinUntil, boosting: now < kart.boostUntil },
        others: heard(now).map((o) => ({ key: o.key, x: o.frame.x, z: o.frame.z, lap: o.frame.lap, progress: o.frame.p, finished: o.frame.f >= 0 ? o.frame.f : null })),
        place: standings(racers).findIndex((r) => r.key === me) + 1, raceMs: raceMs(now), scores: round.scores ?? null, winner: round.winner, wins: { ...round.wins },
      };
    };
  }

  return () => {
    cancelAnimationFrame(frame);
    clearInterval(ticker);
    offFrames();
    sizer.disconnect();
    host.removeEventListener('keydown', onKeyDown);
    host.removeEventListener('keyup', onKeyUp);
    host.removeEventListener('blur', onBlur);
    host.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    for (const s of shown.values()) disposeKart(s);
    for (const o of owned) o.dispose();
    renderer?.forceContextLoss();
    renderer?.dispose();
    renderer?.domElement.remove();
    hud.remove();
    if (exposeHooks) delete (window as unknown as { __daveGame?: unknown }).__daveGame;
  };
}
