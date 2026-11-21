// Bonk on screen (core/bonk.ts): my ball, everyone else's as their apps say, the floe and the sea, in three.js; the keys,
// a stick on a touch screen, the sounds; the round, run by its leader. Loaded only once a friend plays (client/Game.tsx):
// three.js is most of a megabyte.
import * as THREE from 'three';
import {
  BALL_RADIUS, FLOE_START, RESPAWN_MS, SUNK_Y, BONK_AGAIN_MS, advance, ahead, ballAt, ballFrame, bonk, dash, firstRound, floeRadius, hitFrame, knocked, leaderOf, parseFrame,
  roll, roundFrame, roundOf, spawnAt, steer, whoOf, COUNT_MS, type Ball, type BallFrame, type Counted, type GameView, type Round,
} from '../core/bonk';
import type { GameLinks } from './gamelinks';
import { exposeHooks } from './hooks';
import { cueContext } from './sound';

/** A player as the game shows them: the name this browser shows, and their profile picture, if any. */
export type Face = { name: string; picture: string | null };

/** How often my ball goes to the others, and the round from its leader. */
const SEND_MS = 50;
const ROUND_SEND_MS = 250;
/** A player not heard from for this long is out of the game, for the rounds: a hidden tab, a link gone. */
const HEARD_MS = 2500;
/** The longest step the simulation takes at once; a longer gap (a hidden tab) is cut to it. */
const MAX_STEP_S = 0.05;

type Other = { frame: BallFrame; at: number; key: string };


/** A colour of its own for every player, from their key: the same on every screen. */
function colourOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

/**
 * The ball's skin: its colour all round, the face on its front and back. A sphere's texture wraps it once round: a
 * quarter of the way across is the side toward the camera, the face a little above the middle, toward it as it looks
 * down.
 */
function skin(face: Face, colour: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = colour;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(0, 118, 512, 20);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const mark = face.picture ?? (face.name.trim()[0] ?? '?').toUpperCase();
  g.font = face.picture ? '112px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif' : 'bold 112px system-ui, sans-serif';
  g.fillStyle = '#fff';
  for (const x of [128, 384]) g.fillText(mark, x, 100);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A name over a ball. */
function nameTag(text: string, mine: boolean): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  g.font = 'bold 52px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = Math.min(500, g.measureText(text).width + 40);
  g.fillStyle = mine ? 'rgba(255, 196, 0, 0.9)' : 'rgba(10, 30, 50, 0.65)';
  g.beginPath();
  g.roundRect(256 - w / 2, 10, w, 76, 38);
  g.fill();
  g.fillStyle = mine ? '#1a1300' : '#fff';
  g.fillText(text, 256, 50, 460);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(4.2, 0.79, 1);
  s.renderOrder = 10;
  return s;
}

/** A word that pops up where two balls met, rises and fades. */
function popWord(text: string, colour: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.font = '900 72px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = '#0b2033';
  g.strokeText(text, 128, 64);
  g.fillStyle = colour;
  g.fillText(text, 128, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(2.4, 1.2, 1);
  s.renderOrder = 11;
  return s;
}

/** A short thump for a bonk, as loud as it was hard, through the cues' audio (client/sound.ts). */
function thump(hard: number, high = false): void {
  const c = cueContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = high ? 'triangle' : 'sine';
  const f = high ? 520 : 170 + Math.min(hard, 15) * 8;
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.exponentialRampToValueAtTime(f * (high ? 1.6 : 0.45), t + 0.16);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.min(0.5, 0.08 + hard * 0.03), t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.25);
}

/** A splash: falling water noise, for a ball that went in. */
function splash(): void {
  const c = cueContext();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2500, t);
  filter.frequency.exponentialRampToValueAtTime(300, t + 0.5);
  const gain = c.createGain();
  gain.gain.value = 0.25;
  src.connect(filter).connect(gain).connect(c.destination);
  src.start(t);
}

const isTyping = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * Bonk, in `host`, for me (`me`, my key), over `links` to the other players. `faceOf` names and pictures a player. Returns
 * how to stop it.
 */
export function mountBonk(host: HTMLElement, opts: { me: string; links: GameLinks; faceOf: (key: string) => Face }): () => void {
  const { me, links } = opts;
  const myWho = whoOf(me);
  const others = new Map<string, Other>();
  let ball: Ball = { ...ballAt(0, 0), ...spawnAt(0, 1) };
  /** The round I play; 0 while I watch one or none is on. */
  let playing = 0;
  let round: Round = firstRound(performance.now());
  /**
   * Whose round frames I take, and the newest of each: by its sender's clock (ms), so a leader who reloads, and counts
   * again, still counts on from where they were.
   */
  const roundSeq = new Map<string, number>();
  let sentRound = 0;
  let leader: string | null = me;
  let fellAt: number | null = null;
  let lastFloe = FLOE_START;
  let input = { x: 0, z: 0 };
  let dashAsked = false;
  let dashed = false;
  let last = performance.now();
  let lastSent = 0;
  let lastRoundSent = 0;
  let shake = 0;
  /** When my ball last bonked each other player's, either app's working out: the same bonk is not taken twice. */
  const bonkedAt = new Map<string, number>();
  const events: { kind: 'bonk' | 'splash'; x: number; z: number; hard: number }[] = [];

  // The round: who plays it, where they start, and what I do in it.
  const took = (next: Round, now: number) => {
    const was = round;
    round = next;
    if (next.n === was.n && next.phase === was.phase) return;
    if (next.phase === 'count') {
      const i = next.players.indexOf(myWho);
      if (i >= 0) { playing = next.n; ball = { ...ballAt(0, 0), ...spawnAt(i, next.players.length) }; fellAt = null; }
      else { playing = 0; ball = { ...ball, alive: false, y: SUNK_Y }; }
    } else if (next.phase === 'play' && playing !== next.n) {
      // Came in after the countdown: this round is watched.
      playing = 0;
      ball = { ...ball, alive: false, y: SUNK_Y };
    } else if (next.phase === 'wait') {
      playing = 0;
      if (!ball.alive) { ball = { ...ballAt(0, 0), ...spawnAt(0, 1) }; fellAt = null; }
    } else if (next.phase === 'over') {
      lastFloe = floeRadius('play', now - was.since, lastFloe);
      if (next.winner === myWho) thump(6, true);
    }
  };

  const heard = (now: number): Other[] => [...others.values()].filter((o) => now - o.at < HEARD_MS);

  const offFrames = links.listen((from, data) => {
    const f = parseFrame(data);
    if (!f) return;
    const now = performance.now();
    if (f.k === 'b') { others.set(from, { frame: f, at: now, key: from }); return; }
    if (f.k === 'h') {
      // A bonk the other app worked out, for my ball: taken unless mine worked out the same one a moment ago.
      if (f.to !== myWho || now - (bonkedAt.get(from) ?? -Infinity) < BONK_AGAIN_MS || !ball.alive) return;
      bonkedAt.set(from, now);
      ball = knocked(ball, f);
      events.push({ kind: 'bonk', x: ball.x, z: ball.z, hard: f.hit });
      thump(f.hit);
      shake = Math.min(0.6, shake + f.hit * 0.04);
      return;
    }
    // A round frame: the leader's only, and no older than the last of theirs.
    if (from !== leader || f.q <= (roundSeq.get(from) ?? -1)) return;
    roundSeq.set(from, f.q);
    const next = roundOf(f, now);
    // The same phase as I have it: the time it began stays put, unless it is well off, so the floe does not judder.
    took(next.n === round.n && next.phase === round.phase && Math.abs(next.since - round.since) < 150 ? { ...next, since: round.since } : next, now);
  });

  function step(now: number): void {
    let dt = (now - last) / 1000;
    last = now;
    const around = heard(now);
    leader = leaderOf([{ key: me, n: round.n }, ...around.map((o) => ({ key: o.key, n: o.frame.n }))]);
    if (leader === me) {
      const counted: Counted[] = [{ who: myWho, n: playing, known: round.n, alive: ball.alive }, ...around.map((o) => ({ who: whoOf(o.key), n: o.frame.r, known: o.frame.n, alive: o.frame.a }))];
      const next = advance(round, now, counted);
      if (next !== round) { took(next, now); lastRoundSent = 0; }
      if (now - lastRoundSent >= ROUND_SEND_MS) { sentRound = Math.max(Date.now(), sentRound + 1); links.broadcast(JSON.stringify(roundFrame(round, now, sentRound))); lastRoundSent = now; }
    }
    const ms = now - round.since;
    const floe = floeRadius(round.phase, ms, lastFloe);
    const watching = playing === 0 && (round.phase === 'count' || round.phase === 'play');
    if (watching) dashAsked = false;
    while (dt > 0 && !watching) {
      const h = Math.min(dt, MAX_STEP_S / 3);
      dt -= h;
      if (round.phase === 'count') break; // standing at the start, until the go
      if (dashAsked) { const d = dash(ball, input, now); if (d !== ball) { ball = d; dashed = true; thump(2, true); } dashAsked = false; }
      const wasAlive = ball.alive;
      ball = roll(ball, input, h, floe);
      if (wasAlive && !ball.alive) { fellAt = now; events.push({ kind: 'splash', x: ball.x, z: ball.z, hard: 0 }); }
      for (const o of around) {
        const f = o.frame;
        // Between rounds everyone bonks everyone; in a round, only those playing it.
        if (!f.a || (round.phase === 'play' && f.r !== playing)) continue;
        const met = bonk(ball, ahead({ x: f.x, z: f.z, vx: f.vx, vz: f.vz, alive: true }, now - o.at));
        if (met.hit === 0) { ball = met.ball; continue; }
        // Taken a moment ago, from either side: only kept apart.
        if (now - (bonkedAt.get(o.key) ?? -Infinity) < BONK_AGAIN_MS) { ball = { ...ball, x: met.ball.x, z: met.ball.z }; continue; }
        ball = met.ball;
        bonkedAt.set(o.key, now);
        links.sendTo(o.key, JSON.stringify(hitFrame(o.key, met.knock, met.hit)));
        if (met.hit > 0.5) { events.push({ kind: 'bonk', x: (ball.x + f.x) / 2, z: (ball.z + f.z) / 2, hard: met.hit }); thump(met.hit); shake = Math.min(0.6, shake + met.hit * 0.04); }
      }
    }
    // Fell off between rounds: back in a moment.
    if (!ball.alive && fellAt !== null && now - fellAt > RESPAWN_MS && round.phase === 'wait') {
      const a = Math.random() * Math.PI * 2;
      ball = ballAt(Math.cos(a) * FLOE_START * 0.5, Math.sin(a) * FLOE_START * 0.5);
      fellAt = null;
    }
    if (now - lastSent >= SEND_MS) {
      links.broadcast(JSON.stringify(ballFrame(watching ? { ...ball, alive: false, y: SUNK_Y } : ball, playing, round.n, dashed)));
      dashed = false;
      lastSent = now;
    }
  }

  // Keys while the game has the focus; a stick on a touch screen.
  const keys = new Set<string>();
  const fromKeys = () => {
    const x = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
    const z = (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0);
    input = steer(x, z);
  };
  const MOVE_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); fromKeys(); e.preventDefault(); }
    else if (e.code === 'Space') { dashAsked = true; e.preventDefault(); }
  };
  const onKeyUp = (e: KeyboardEvent) => { if (keys.delete(e.code)) fromKeys(); };
  const onBlur = () => { keys.clear(); fromKeys(); };
  host.tabIndex = 0;
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keyup', onKeyUp);
  host.addEventListener('blur', onBlur);

  // The HUD: what is going on, the wins, how to play, and the dash button on a touch screen.
  const hud = document.createElement('div');
  hud.className = 'bonk-hud';
  const banner = document.createElement('div');
  banner.className = 'bonk-banner';
  const board = document.createElement('ol');
  board.className = 'bonk-board';
  board.setAttribute('aria-label', 'Rounds won');
  const help = document.createElement('div');
  help.className = 'bonk-help';
  help.textContent = 'Arrows or WASD to roll · Space to dash · bonk everyone into the sea';
  const dashButton = document.createElement('button');
  dashButton.type = 'button';
  dashButton.className = 'bonk-dash';
  dashButton.textContent = 'Dash';
  dashButton.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); dashAsked = true; });
  const stick = document.createElement('div');
  stick.className = 'bonk-stick';
  hud.append(banner, board, help, dashButton, stick);
  host.append(hud);

  let touch: { id: number; x: number; y: number } | null = null;
  const onPointerDown = (e: PointerEvent) => {
    host.focus({ preventScroll: true });
    if (e.pointerType === 'mouse') return;
    host.classList.add('bonk-touch');
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY };
    stick.style.left = `${e.clientX - host.getBoundingClientRect().left}px`;
    stick.style.top = `${e.clientY - host.getBoundingClientRect().top}px`;
    stick.classList.add('on');
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    input = steer((e.clientX - touch.x) / 45, (e.clientY - touch.y) / 45);
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

  // The scene, in WebGL 2, which three.js needs. A browser without it plays all the same, blind, and the HUD says so;
  // asked here first, so three.js does not fail at it out loud.
  let renderer: THREE.WebGLRenderer | null = null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  try {
    renderer = context ? new THREE.WebGLRenderer({ canvas, context, antialias: true }) : null;
  } catch {
    renderer = null;
  }
  const scene = new THREE.Scene();
  const sky = new THREE.Color('#bfe6ff');
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 30, 70);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  scene.add(new THREE.HemisphereLight('#ffffff', '#2d5f80', 1.6));
  const sun = new THREE.DirectionalLight('#fff6e0', 2.2);
  sun.position.set(-8, 18, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
  scene.add(sun);

  const seaGeometry = new THREE.PlaneGeometry(160, 160, 80, 80);
  seaGeometry.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeometry, new THREE.MeshStandardMaterial({ color: '#1f7fb8', roughness: 0.35, metalness: 0.05, flatShading: true }));
  sea.position.y = -0.7;
  sea.receiveShadow = true;
  scene.add(sea);
  const seaBase = Float32Array.from(seaGeometry.attributes['position']!.array as Float32Array);

  const floe = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.04, 0.6, 72), new THREE.MeshStandardMaterial({ color: '#f4fbff', roughness: 0.3 }));
  top.position.y = -0.3;
  top.receiveShadow = true;
  const under = new THREE.Mesh(new THREE.CylinderGeometry(1.04, 0.7, 1.8, 72), new THREE.MeshStandardMaterial({ color: '#9fd6f2', roughness: 0.15, transparent: true, opacity: 0.85 }));
  under.position.y = -1.5;
  floe.add(top, under);
  scene.add(floe);
  // Cracks of a darker blue round the edge, a ring that shows where the floe ends.
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 72), new THREE.MeshBasicMaterial({ color: '#6fb6dd' }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.005;
  floe.add(rim);

  const snowCount = 500;
  const snowGeometry = new THREE.BufferGeometry();
  const snowAt = new Float32Array(snowCount * 3);
  for (let i = 0; i < snowCount; i++) { snowAt[i * 3] = (Math.random() - 0.5) * 50; snowAt[i * 3 + 1] = Math.random() * 20; snowAt[i * 3 + 2] = (Math.random() - 0.5) * 50; }
  snowGeometry.setAttribute('position', new THREE.BufferAttribute(snowAt, 3));
  const snow = new THREE.Points(snowGeometry, new THREE.PointsMaterial({ color: '#ffffff', size: 0.12, transparent: true, opacity: 0.85 }));
  scene.add(snow);

  const marker = new THREE.Mesh(new THREE.RingGeometry(BALL_RADIUS * 1.15, BALL_RADIUS * 1.4, 40), new THREE.MeshBasicMaterial({ color: '#ffc400', transparent: true, opacity: 0.85 }));
  marker.rotation.x = -Math.PI / 2;
  scene.add(marker);

  type Shown = { group: THREE.Group; body: THREE.Mesh; tag: THREE.Sprite; face: string; x: number; z: number; y: number; splashed: boolean; flash: number };
  const shown = new Map<string, Shown>();
  const sphere = new THREE.SphereGeometry(BALL_RADIUS, 40, 28);
  const show = (key: string): Shown => {
    const f = opts.faceOf(key);
    const id = `${f.name}\n${f.picture ?? ''}`;
    let s = shown.get(key);
    if (s && s.face === id) return s;
    if (s) { scene.remove(s.group); dispose(s.group); }
    const body = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial({ map: skin(f, colourOf(key)), roughness: 0.4, metalness: 0.05 }));
    body.castShadow = true;
    const tag = nameTag(key === me ? 'You' : f.name, key === me);
    tag.position.y = BALL_RADIUS + 0.85;
    const group = new THREE.Group();
    group.add(body, tag);
    scene.add(group);
    s = { group, body, tag, face: id, x: 0, z: 0, y: 0, splashed: false, flash: 0 };
    shown.set(key, s);
    return s;
  };
  const pops: { sprite: THREE.Sprite; born: number }[] = [];
  const drops: { points: THREE.Points; v: Float32Array; born: number }[] = [];

  function dispose(o: THREE.Object3D): void {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.geometry && m.geometry !== sphere) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose(); }
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

  const tmp = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  function draw(now: number, dt: number): void {
    const ms = now - round.since;
    const r = floeRadius(round.phase, ms, lastFloe);
    const bob = Math.sin(now / 900) * 0.04;
    floe.scale.set(Math.max(r, 0.001), 1, Math.max(r, 0.001));
    floe.position.y = bob;
    floe.visible = r > 0.01;

    // The sea's waves, rolling by.
    const pos = seaGeometry.attributes['position'] as THREE.BufferAttribute;
    const t = now / 1000;
    for (let i = 0; i < pos.count; i++) {
      const x = seaBase[i * 3]!, z = seaBase[i * 3 + 2]!;
      pos.setY(i, Math.sin(x * 0.35 + t * 1.3) * 0.18 + Math.cos(z * 0.3 + t * 0.9) * 0.18);
    }
    pos.needsUpdate = true;
    seaGeometry.computeVertexNormals();

    for (let i = 0; i < snowCount; i++) {
      let y = snowAt[i * 3 + 1]! - dt * 1.2;
      if (y < -0.5) y = 20;
      snowAt[i * 3 + 1] = y;
      snowAt[i * 3] = snowAt[i * 3]! + Math.sin(t + i) * dt * 0.3;
    }
    snowGeometry.attributes['position']!.needsUpdate = true;

    // The balls: mine where it is, the others' eased toward where their apps last said, carried on.
    const keysShown = new Set<string>();
    const place = (key: string, x: number, z: number, y: number, vx: number, vz: number, dashing: boolean) => {
      const s = show(key);
      keysShown.add(key);
      const ease = key === me ? 1 : 1 - Math.exp(-dt * 18);
      const ox = s.x, oz = s.z;
      s.x += (x - s.x) * ease; s.z += (z - s.z) * ease; s.y += (y - s.y) * ease;
      s.group.position.set(s.x, s.y + BALL_RADIUS + bob, s.z);
      s.group.visible = s.y > SUNK_Y + 0.5;
      // Rolled as far as it went.
      const mx = s.x - ox, mz = s.z - oz;
      const moved = Math.hypot(mx, mz);
      if (moved > 1e-5 && moved < 3) { axis.set(mz, 0, -mx).normalize(); tmp.setFromAxisAngle(axis, moved / BALL_RADIUS); s.body.quaternion.premultiply(tmp); }
      if (dashing) s.flash = 1;
      s.flash = Math.max(0, s.flash - dt * 3);
      const speed = Math.hypot(vx, vz);
      s.body.scale.setScalar(1 + s.flash * 0.15 - Math.min(speed, 15) * 0.004);
      (s.body.material as THREE.MeshStandardMaterial).emissive.setRGB(s.flash * 0.6, s.flash * 0.5, s.flash * 0.1);
      if (s.y < -0.4 && !s.splashed) { s.splashed = true; drops.push(burst(s.x, s.z, now)); if (key !== me) splash(); }
      if (s.y >= 0) s.splashed = false;
    };
    const watching = playing === 0 && (round.phase === 'count' || round.phase === 'play');
    if (!watching) place(me, ball.x, ball.z, ball.y, ball.vx, ball.vz, false);
    for (const o of heard(now)) {
      const f = o.frame;
      const a = ahead({ x: f.x, z: f.z, vx: f.vx, vz: f.vz, alive: f.a }, now - o.at);
      place(o.key, a.x, a.z, f.y, f.vx, f.vz, f.d);
    }
    for (const [key, s] of shown) if (!keysShown.has(key)) s.group.visible = false;
    marker.visible = !watching && ball.alive;
    marker.position.set(shown.get(me)?.x ?? ball.x, 0.02 + bob, shown.get(me)?.z ?? ball.z);
    (marker.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(now / 200) * 0.3;

    for (const e of events.splice(0)) {
      if (e.kind === 'splash') { splash(); continue; }
      const p = popWord(e.hard > 9 ? 'BONK!!' : 'bonk!', e.hard > 9 ? '#ff5d73' : '#ffd23f');
      p.position.set(e.x, 1.6, e.z);
      scene.add(p);
      pops.push({ sprite: p, born: now });
    }
    for (const p of [...pops]) {
      const age = (now - p.born) / 700;
      p.sprite.position.y += dt * 1.6;
      (p.sprite.material as THREE.SpriteMaterial).opacity = 1 - age;
      if (age >= 1) { scene.remove(p.sprite); dispose(p.sprite); pops.splice(pops.indexOf(p), 1); }
    }
    for (const d of [...drops]) {
      const age = (now - d.born) / 900;
      const a = d.points.geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) {
        d.v[i * 3 + 1] = d.v[i * 3 + 1]! - 14 * dt;
        a.setXYZ(i, a.getX(i) + d.v[i * 3]! * dt, a.getY(i) + d.v[i * 3 + 1]! * dt, a.getZ(i) + d.v[i * 3 + 2]! * dt);
      }
      a.needsUpdate = true;
      (d.points.material as THREE.PointsMaterial).opacity = 1 - age;
      if (age >= 1) { scene.remove(d.points); dispose(d.points); drops.splice(drops.indexOf(d), 1); }
    }

    // The camera: over the floe from the south, a little toward my ball, further back on a tall screen; shaken by a bonk.
    const far = Math.max(1, 1.25 / camera.aspect);
    const fx = watching ? 0 : ball.x * 0.2, fz = watching ? 0 : ball.z * 0.2;
    shake = Math.max(0, shake - dt * 1.5);
    camera.position.set(fx + (Math.random() - 0.5) * shake, 15 * far + (Math.random() - 0.5) * shake, fz + 13 * far);
    camera.lookAt(fx, -0.5, fz + 0.5);
    renderer?.render(scene, camera);
  }

  function burst(x: number, z: number, now: number): (typeof drops)[number] {
    const n = 60;
    const at = new Float32Array(n * 3);
    const v = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
      at.set([x, -0.5, z], i * 3);
      v.set([Math.cos(a) * s, 4 + Math.random() * 5, Math.sin(a) * s], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(at, 3));
    const points = new THREE.Points(g, new THREE.PointsMaterial({ color: '#d9f3ff', size: 0.22, transparent: true }));
    scene.add(points);
    return { points, v, born: now };
  }

  // The HUD, as the round goes.
  let hudKey = '';
  function updateHud(now: number): void {
    const ms = now - round.since;
    const alone = heard(now).length === 0;
    const watching = playing === 0 && (round.phase === 'count' || round.phase === 'play');
    const name = (who: string | null) => {
      if (who === null) return null;
      if (who === myWho) return 'You';
      const o = [...others.values()].find((x) => whoOf(x.key) === who);
      return o ? opts.faceOf(o.key).name : 'Someone';
    };
    let text: string;
    if (round.phase === 'wait') text = alone ? 'Waiting for a friend to join… roll around meanwhile' : 'Next round starts soon';
    else if (round.phase === 'count') text = watching ? 'You are in the next round' : String(Math.max(1, Math.ceil((COUNT_MS - ms) / 1000)));
    else if (round.phase === 'play') text = watching ? 'You are in the next round' : ms < 900 ? 'Bonk!' : !ball.alive ? 'Splash! You are out' : '';
    else { const w = name(round.winner); text = w === null ? 'Splash! Nobody is left' : w === 'You' ? '🏆 You win!' : `🏆 ${w} wins!`; }
    const wins = Object.entries(round.wins).sort((a, b) => b[1] - a[1]);
    const key = `${text}|${JSON.stringify(wins)}|${round.phase}`;
    if (key === hudKey) return;
    hudKey = key;
    banner.textContent = text;
    banner.dataset['phase'] = round.phase;
    banner.classList.toggle('big', round.phase === 'count' || (round.phase === 'play' && text === 'Bonk!') || round.phase === 'over');
    board.replaceChildren(...wins.map(([who, n]) => { const li = document.createElement('li'); li.textContent = `${name(who) ?? 'Someone'} ${'🏆'.repeat(Math.min(n, 5))}${n > 5 ? ` ${n}` : ''}`; return li; }));
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
  // A hidden tab draws nothing, but its ball still goes on and is still sent, so the round does not wait for it.
  const ticker = setInterval(() => { const now = performance.now(); if (now - last > 200) { step(now); updateHud(now); } }, 200);
  host.focus({ preventScroll: true });

  if (exposeHooks) {
    (window as unknown as { __daveGame?: () => GameView }).__daveGame = (): GameView => {
      const now = performance.now();
      return {
        phase: round.phase, round: round.n, leader, playing: playing !== 0, spectating: playing === 0 && (round.phase === 'count' || round.phase === 'play'), webgl: renderer !== null,
        me: { x: ball.x, z: ball.z, alive: ball.alive },
        others: heard(now).map((o) => ({ key: o.key, x: o.frame.x, z: o.frame.z, alive: o.frame.a })),
        wins: { ...round.wins }, connected: links.connected().length,
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
    sphere.dispose();
    // Given back now, not when it is collected: a browser keeps only so many at once, and each Leave and Join makes one.
    renderer?.forceContextLoss();
    renderer?.dispose();
    renderer?.domElement.remove();
    hud.remove();
    if (exposeHooks) delete (window as unknown as { __daveGame?: unknown }).__daveGame;
  };
}
