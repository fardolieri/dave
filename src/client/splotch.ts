// Splotch on screen (core/splotch.ts): the board and its paint, my blob, everyone else's as their apps say, in three.js;
// the keys, a stick on a touch screen, the sounds; the round, run by its leader (core/rounds.ts). Loaded only once a
// friend plays it (client/Game.tsx).
import * as THREE from 'three';
import {
  BLOB_RADIUS, BOARD, COUNT_MS, HALF, SPLAT_RADIUS, advance, blobAt, emptyBoard, move, paintDisc, paintFrame, paintPath, parseFrame, roundLeader, secondsLeft, splat,
  startAt, tally, type Blob, type Counted, type PaintFrame, type SplotchView,
} from '../core/splotch';
import { firstRound, roundFrame, roundOf, whoOf, type Round } from '../core/rounds';
import type { GameLinks } from './gamelinks';
import { exposeHooks } from './hooks';
import { colourOf, isTyping, nameTag, skin, threeColourOf, thump, type Face } from './gamekit';
import { cueContext } from './sound';

const SEND_MS = 50;
const ROUND_SEND_MS = 250;
/** A player not heard from for this long is out of the game, for the rounds: a hidden tab, a link gone. */
const HEARD_MS = 2500;
const MAX_STEP_S = 0.05;

/** Another player as this app last heard of them: where their trail was last painted to, and their last splat painted. */
type Other = { key: string; frame: PaintFrame; at: number; painted: { x: number; z: number } | null; splat: number };

/** A wet splat, for a splat of paint. */
function splatSound(): void {
  const c = cueContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.25), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(900, t);
  filter.frequency.exponentialRampToValueAtTime(200, t + 0.25);
  filter.Q.value = 1.5;
  const gain = c.createGain();
  gain.gain.value = 0.6;
  src.connect(filter).connect(gain).connect(c.destination);
  src.start(t);
}

/** The colour a player paints, as red, green and blue of 0 to 255. */
function rgbOf(key: string): [number, number, number] {
  const c = threeColourOf(key).getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

/** Splotch, in `host`, for me (`me`, my key), over `links` to the other players. Returns how to stop it. */
export function mountSplotch(host: HTMLElement, opts: { me: string; links: GameLinks; faceOf: (key: string) => Face }): () => void {
  const { me, links } = opts;
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  const board = emptyBoard();
  /** Tiles painted since the board was last drawn. */
  const fresh = new Set<number>();
  let blob: Blob = blobAt(0, 0);
  let painted: { x: number; z: number } | null = null;
  /** The round I play; 0 while I watch one or none is on. */
  let playing = 0;
  let round: Round = firstRound(performance.now());
  const roundSeq = new Map<string, number>();
  let sentRound = 0;
  let leader: string | null = me;
  let input = { x: 0, z: 0 };
  let splatAsked = false;
  let last = performance.now();
  let lastSent = 0;
  let lastRoundSent = 0;
  const splats: { x: number; z: number; key: string }[] = [];

  /** Who a tile's paint is, by the start of a key, as a key: mine, a friend's I hear from; the board keeps only the start. */
  const keyOfWho = (who: string): string | null => (who === myWho ? me : [...others.keys()].find((k) => whoOf(k) === who) ?? null);
  const paintMine = (changed: number[]) => { for (const i of changed) fresh.add(i); };
  const clearBoard = () => { for (let i = 0; i < board.length; i++) if (board[i] !== null) { board[i] = null; fresh.add(i); } };
  // Between rounds everyone paints, for fun; in a round, those who play it; and not while the round's end is shown.
  const paints = (r: number) => round.phase === 'wait' || (round.phase === 'play' && r === round.n && r !== 0);
  const watching = () => playing === 0 && (round.phase === 'count' || round.phase === 'play');

  const took = (next: Round) => {
    const was = round;
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    if (next.phase === 'count') {
      clearBoard();
      for (const o of others.values()) o.painted = null;
      const i = next.players.indexOf(myWho);
      playing = i >= 0 ? next.n : 0;
      blob = { ...blobAt(0, 0), ...(i >= 0 ? startAt(i, next.players.length) : {}), splat: blob.splat };
      painted = null;
    } else if (next.phase === 'play' && playing !== next.n) {
      playing = 0; // came in after the countdown: this round is watched
    } else if (next.phase === 'wait') {
      playing = 0;
    } else if (next.phase === 'over' && next.winner === myWho) {
      thump(6, true);
    }
  };

  const heard = (now: number): Other[] => [...others.values()].filter((o) => now - o.at < HEARD_MS);

  const offFrames = links.listen((from, data) => {
    const f = parseFrame(data);
    if (!f) return;
    const now = performance.now();
    if (f.k === 'p') {
      // A splat from before I heard of them is not painted: it was on a board from before.
      const o = others.get(from) ?? { key: from, frame: f, at: now, painted: null, splat: f.s };
      // Their trail since their last frame, and a splat for every one made since (a lost frame's too).
      if (paints(f.r)) {
        if (o.painted) for (const i of paintPath(board, whoOf(from), o.painted, f)) fresh.add(i);
        if (f.s > o.splat) { for (const i of paintDisc(board, whoOf(from), f.x, f.z, SPLAT_RADIUS)) fresh.add(i); splats.push({ x: f.x, z: f.z, key: from }); }
        o.painted = { x: f.x, z: f.z };
      } else {
        o.painted = null;
      }
      // A frame that comes after a later one (the channel keeps no order) does not take the last splat back.
      others.set(from, { ...o, frame: f, at: now, splat: Math.max(o.splat, f.s) });
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
    leader = roundLeader([{ key: me, known: round.n, playing }, ...around.map((o) => ({ key: o.key, known: o.frame.n, playing: o.frame.r }))]);
    if (leader === me) {
      const counted: Counted[] = [{ who: myWho, n: playing, known: round.n }, ...around.map((o) => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n }))];
      const next = advance(round, now, counted, () => board);
      if (next !== round) { took(next); lastRoundSent = 0; }
      if (now - lastRoundSent >= ROUND_SEND_MS) { sentRound = Math.max(Date.now(), sentRound + 1); links.broadcast(JSON.stringify(roundFrame(round, now, sentRound))); lastRoundSent = now; }
    }
    const still = watching() || round.phase === 'count' || round.phase === 'over';
    if (still) { splatAsked = false; dt = 0; painted = null; }
    while (dt > 0) {
      const h = Math.min(dt, MAX_STEP_S / 3);
      dt -= h;
      blob = move(blob, input, h);
    }
    if (!still && paints(playing)) {
      if (painted) paintMine(paintPath(board, myWho, painted, blob));
      painted = { x: blob.x, z: blob.z };
      if (splatAsked) {
        const s = splat(blob, now, Date.now());
        if (s !== blob) { blob = s; paintMine(paintDisc(board, myWho, blob.x, blob.z, SPLAT_RADIUS)); splats.push({ x: blob.x, z: blob.z, key: me }); }
      }
    }
    splatAsked = false;
    if (now - lastSent >= SEND_MS) {
      links.broadcast(JSON.stringify(paintFrame(blob, watching() ? 0 : playing, round.n)));
      lastSent = now;
    }
  }

  // Keys while the game has the focus; a stick on a touch screen.
  const keys = new Set<string>();
  const fromKeys = () => {
    const x = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    const z = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    const l = Math.hypot(x, z) || 1;
    input = { x: x / l, z: z / l };
  };
  const MOVE_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); fromKeys(); e.preventDefault(); }
    else if (e.code === 'Space') { splatAsked = true; e.preventDefault(); }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (keys.delete(e.code)) fromKeys(); };
  const onBlur = () => { keys.clear(); fromKeys(); };
  host.tabIndex = 0;
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  host.addEventListener('blur', onBlur);

  const hud = document.createElement('div');
  hud.className = 'bonk-hud splotch-hud';
  const banner = document.createElement('div');
  banner.className = 'bonk-banner';
  const bars = document.createElement('div');
  bars.className = 'splotch-bars';
  const board2 = document.createElement('ol');
  board2.className = 'bonk-board';
  board2.setAttribute('aria-label', 'Rounds won');
  const help = document.createElement('div');
  help.className = 'bonk-help';
  help.textContent = 'Arrows or WASD to move · Space to splat · paint more of the board than anyone';
  const splatButton = document.createElement('button');
  splatButton.type = 'button';
  splatButton.className = 'bonk-dash';
  splatButton.textContent = 'Splat';
  splatButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); splatAsked = true; });
  const stick = document.createElement('div');
  stick.className = 'bonk-stick';
  hud.append(banner, bars, board2, help, splatButton, stick);
  host.append(hud);

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
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    const x = (e.clientX - touch.x) / 45, z = (e.clientY - touch.y) / 45;
    const l = Math.hypot(x, z);
    input = l > 1 ? { x: x / l, z: z / l } : { x, z };
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    touch = null;
    input = { x: 0, z: 0 };
    stick.classList.remove('on');
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
  const sky = new THREE.Color('#fff4dc');
  scene.background = sky;
  const fog = new THREE.Fog(sky, 40, 90);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight('#ffffff', '#7a6a55', 1.7));
  const sun = new THREE.DirectionalLight('#fff3df', 2);
  sun.position.set(-10, 22, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
  scene.add(sun);

  // Grass round the board, and a few trees on it.
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#8fd19e', roughness: 1 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.6;
  grass.receiveShadow = true;
  scene.add(grass);
  const trunk = new THREE.CylinderGeometry(0.25, 0.3, 1.2, 8);
  const crown = new THREE.ConeGeometry(1.3, 2.8, 8);
  const wood = new THREE.MeshStandardMaterial({ color: '#8a5a3c', roughness: 0.9 });
  const leaves = new THREE.MeshStandardMaterial({ color: '#3f9b5a', roughness: 0.8, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.sin(i * 7) * 0.2, r = HALF + 4 + (i % 3) * 2.5;
    const tree = new THREE.Group();
    const t = new THREE.Mesh(trunk, wood), c = new THREE.Mesh(crown, leaves);
    t.position.y = 0; c.position.y = 1.9;
    t.castShadow = c.castShadow = true;
    tree.add(t, c);
    tree.position.set(Math.cos(a) * r, -0.6 + 0.6, Math.sin(a) * r);
    tree.scale.setScalar(0.8 + ((i * 37) % 10) / 20);
    scene.add(tree);
  }

  // The board: one pixel a tile, drawn as it is painted.
  const pixels = new Uint8Array(BOARD * BOARD * 4);
  const base = (i: number): [number, number, number] => (((i % BOARD) + Math.floor(i / BOARD)) % 2 ? [236, 240, 244] : [222, 228, 235]);
  const colours = new Map<string, [number, number, number]>();
  const drawTile = (i: number) => {
    const who = board[i] ?? null;
    let rgb = base(i);
    if (who !== null) {
      let c = colours.get(who);
      const key = c ? null : keyOfWho(who);
      if (key) { c = rgbOf(key); colours.set(who, c); }
      rgb = c ?? [150, 150, 150];
    }
    pixels.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  };
  for (let i = 0; i < board.length; i++) drawTile(i);
  const paint = new THREE.DataTexture(pixels, BOARD, BOARD, THREE.RGBAFormat);
  paint.magFilter = THREE.NearestFilter;
  paint.colorSpace = THREE.SRGBColorSpace;
  paint.flipY = false;
  paint.needsUpdate = true;
  const floorGeometry = new THREE.PlaneGeometry(BOARD, BOARD);
  floorGeometry.rotateX(-Math.PI / 2);
  // The texture's first row is the board's first (z = -HALF), which the rotated plane puts at its far edge: flipped back.
  const uv = floorGeometry.attributes['uv'] as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const floor = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({ map: paint, roughness: 0.55 }));
  floor.receiveShadow = true;
  scene.add(floor);
  const rim = new THREE.Mesh(new THREE.BoxGeometry(BOARD + 1, 0.6, BOARD + 1), new THREE.MeshStandardMaterial({ color: '#5b6b7a', roughness: 0.7 }));
  rim.position.y = -0.31;
  rim.receiveShadow = true;
  scene.add(rim);

  type Shown = { group: THREE.Group; body: THREE.Mesh; face: string; x: number; z: number; hop: number };
  const shown = new Map<string, Shown>();
  const sphere = new THREE.SphereGeometry(BLOB_RADIUS, 36, 24);
  const show = (key: string): Shown => {
    const f = opts.faceOf(key);
    const id = `${f.name}\n${f.picture ?? ''}`;
    let s = shown.get(key);
    if (s && s.face === id) return s;
    if (s) { scene.remove(s.group); dispose(s.group); }
    const body = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial({ map: skin(f, colourOf(key)), roughness: 0.25, metalness: 0.05 }));
    body.castShadow = true;
    const tag = nameTag(key === me ? 'You' : f.name, key === me);
    tag.position.y = BLOB_RADIUS + 0.95;
    const group = new THREE.Group();
    group.add(body, tag);
    scene.add(group);
    s = { group, body, face: id, x: 0, z: 0, hop: 0 };
    shown.set(key, s);
    return s;
  };
  const drops: { points: THREE.Points; v: Float32Array; born: number }[] = [];
  function burst(x: number, z: number, key: string, now: number): void {
    const n = 70;
    const at = new Float32Array(n * 3), v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
      at.set([x, 0.4, z], i * 3);
      v.set([Math.cos(a) * s, 3 + Math.random() * 5, Math.sin(a) * s], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(at, 3));
    const points = new THREE.Points(g, new THREE.PointsMaterial({ color: threeColourOf(key), size: 0.3, transparent: true }));
    scene.add(points);
    drops.push({ points, v, born: now });
  }

  function dispose(o: THREE.Object3D): void {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.geometry && m.geometry !== sphere && m.geometry !== trunk && m.geometry !== crown) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { if (mat === wood || mat === leaves) continue; (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose(); }
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

  function draw(now: number, dt: number): void {
    if (fresh.size) { for (const i of fresh) drawTile(i); fresh.clear(); paint.needsUpdate = true; }
    const keysShown = new Set<string>();
    const place = (key: string, x: number, z: number, vx: number, vz: number) => {
      const s = show(key);
      keysShown.add(key);
      const ease = key === me ? 1 : 1 - Math.exp(-dt * 18);
      s.x += (x - s.x) * ease; s.z += (z - s.z) * ease;
      const speed = Math.hypot(vx, vz);
      s.hop += dt * (4 + speed * 1.6);
      const up = speed > 0.3 ? Math.abs(Math.sin(s.hop)) * 0.35 : 0;
      s.group.position.set(s.x, BLOB_RADIUS * 0.85 + up, s.z);
      // Squashed as it lands, stretched as it leaves the board; leaning the way it goes.
      const squash = 1 - (speed > 0.3 ? (0.35 - up) * 0.4 : 0);
      s.body.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
      if (speed > 0.3) s.body.rotation.y = Math.atan2(vx, vz);
      s.group.visible = true;
    };
    if (!watching()) place(me, blob.x, blob.z, blob.vx, blob.vz);
    for (const o of heard(now)) if (!(round.phase === 'play' && o.frame.r === 0)) place(o.key, o.frame.x + o.frame.vx * Math.min(0.25, (now - o.at) / 1000), o.frame.z + o.frame.vz * Math.min(0.25, (now - o.at) / 1000), o.frame.vx, o.frame.vz);
    for (const [key, s] of shown) if (!keysShown.has(key)) s.group.visible = false;
    for (const s of splats.splice(0)) { burst(s.x, s.z, s.key, now); splatSound(); }
    for (const d of [...drops]) {
      const age = (now - d.born) / 700;
      const a = d.points.geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        d.v[i * 3 + 1] = d.v[i * 3 + 1]! - 16 * dt;
        a.setXYZ(i, a.getX(i) + d.v[i * 3]! * dt, Math.max(0.02, a.getY(i) + d.v[i * 3 + 1]! * dt), a.getZ(i) + d.v[i * 3 + 2]! * dt);
      }
      a.needsUpdate = true;
      (d.points.material as THREE.PointsMaterial).opacity = 1 - age;
      if (age >= 1) { scene.remove(d.points); dispose(d.points); drops.splice(drops.indexOf(d), 1); }
    }
    // The whole board in view, near edge too, whatever the tile's shape: further back on a tall screen.
    const far = Math.max(1, 1.35 / camera.aspect);
    camera.position.set(0, 31 * far, 21 * far);
    fog.near = 40 * far;
    fog.far = 90 * far;
    camera.lookAt(0, -0.5, 0.8);
    renderer?.render(scene, camera);
  }

  let hudKey = '';
  function updateHud(now: number): void {
    const ms = now - round.since;
    const alone = heard(now).length === 0;
    const name = (who: string | null) => {
      if (who === null) return null;
      if (who === myWho) return 'You';
      const key = keyOfWho(who);
      return key ? opts.faceOf(key).name : 'Someone';
    };
    let text: string;
    if (round.phase === 'wait') text = alone ? 'Waiting for a friend to join… paint around meanwhile' : 'Next round starts soon';
    else if (round.phase === 'count') text = watching() ? 'You are in the next round' : String(Math.max(1, Math.ceil((COUNT_MS - ms) / 1000)));
    else if (round.phase === 'play') text = watching() ? 'You are in the next round' : ms < 900 ? 'Paint!' : `${secondsLeft('play', ms)}`;
    else { const w = name(round.winner); text = w === null ? 'A tie!' : w === 'You' ? '🏆 You win!' : `🏆 ${w} wins!`; }
    // The share of the board each has: the leader's count once the round is over, else this board's.
    const counts = round.phase === 'over' && round.scores ? round.scores : tally(board);
    const shares = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const wins = Object.entries(round.wins).sort((a, b) => b[1] - a[1]);
    const key = `${text}|${JSON.stringify(shares)}|${JSON.stringify(wins)}|${round.phase}`;
    if (key === hudKey) return;
    hudKey = key;
    banner.textContent = text;
    banner.classList.toggle('big', round.phase === 'count' || (round.phase === 'play' && text === 'Paint!') || round.phase === 'over');
    banner.classList.toggle('clock', round.phase === 'play' && text !== 'Paint!' && text !== 'You are in the next round');
    bars.replaceChildren(...shares.map(([who, n]) => {
      const bar = document.createElement('span');
      const k = keyOfWho(who);
      bar.style.flexGrow = String(n);
      bar.style.background = k ? colourOf(k) : '#999';
      bar.title = `${name(who) ?? 'Someone'}: ${Math.round((n / (BOARD * BOARD)) * 100)} %`;
      return bar;
    }));
    board2.replaceChildren(...wins.map(([who, n]) => { const li = document.createElement('li'); li.textContent = `${name(who) ?? 'Someone'} ${'🏆'.repeat(Math.min(n, 5))}${n > 5 ? ` ${n}` : ''}`; return li; }));
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
  // A hidden tab draws nothing, but its blob is still sent, so the round does not wait for it.
  const ticker = setInterval(() => { const now = performance.now(); if (now - last > 200) { step(now); updateHud(now); } }, 200);
  host.focus({ preventScroll: true });

  if (exposeHooks) {
    (window as unknown as { __daveGame?: () => SplotchView }).__daveGame = (): SplotchView => {
      const now = performance.now();
      return {
        game: 'splotch', phase: round.phase, round: round.n, leader, playing: playing !== 0, connected: links.connected().length,
        me: { x: blob.x, z: blob.z }, others: heard(now).map((o) => ({ key: o.key, x: o.frame.x, z: o.frame.z })),
        tiles: tally(board), scores: round.scores ?? null, winner: round.winner, wins: { ...round.wins },
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
    dispose(scene);
    sphere.dispose(); trunk.dispose(); crown.dispose(); wood.dispose(); leaves.dispose();
    renderer?.forceContextLoss();
    renderer?.dispose();
    renderer?.domElement.remove();
    hud.remove();
    if (exposeHooks) delete (window as unknown as { __daveGame?: unknown }).__daveGame;
  };
}
