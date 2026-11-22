// What every game draws and sounds alike (client/bonk.ts, client/clink.ts): a player's colour, their face on a ball,
// their name over it, a word that pops up, a thump and a splash, through the cues' audio (client/sound.ts); whether the
// browser draws without a GPU.
import * as THREE from 'three';
import { cueContext } from './sound';

/** A player as the game shows them: the name this browser shows, and their profile picture, if any. */
export type Face = { name: string; picture: string | null };

/** A colour of its own for every player, from their key: the same on every screen. Its hue, 0 to 359. */
function hueOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}
/** The player's colour, as CSS and a canvas take it. */
export const colourOf = (key: string): string => `hsl(${hueOf(key)} 70% 62%)`;
/** The same colour, as three.js takes it (its parser wants commas in hsl()). */
export const threeColourOf = (key: string): THREE.Color => new THREE.Color().setHSL(hueOf(key) / 360, 0.7, 0.62, THREE.SRGBColorSpace);

/**
 * The ball's skin: its colour all round, the face on its front and back. A sphere's texture wraps it once round: a
 * quarter of the way across is the side toward the camera, the face a little above the middle, toward it as it looks
 * down.
 */
export function skin(face: Face, colour: string): THREE.CanvasTexture {
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
export function nameTag(text: string, mine: boolean): THREE.Sprite {
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

/** A word that pops up where two balls met, rises and fades: a longer one wider, its letters as big. */
export function popWord(text: string, colour: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const font = '900 72px system-ui, sans-serif';
  const measure = c.getContext('2d')!;
  measure.font = font;
  c.width = Math.max(256, Math.ceil(measure.measureText(text).width) + 24); c.height = 128;
  // A canvas sized anew starts over: its font too.
  const g = c.getContext('2d')!;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = '#0b2033';
  g.strokeText(text, c.width / 2, 64);
  g.fillStyle = colour;
  g.fillText(text, c.width / 2, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set((2.4 * c.width) / 256, 1.2, 1);
  s.renderOrder = 11;
  return s;
}

/** A short thump for a bonk, as loud as it was hard, through the cues' audio (client/sound.ts). */
export function thump(hard: number, high = false): void {
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
export function splash(): void {
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

/**
 * Whether WebGL is drawn without a GPU. The renderer's own name where the browser gives it (Firefox), else the debug
 * extension's (Chromium and Safari mask the plain one; Firefox warns of the extension, so it is asked only there).
 */
export function isSoftware(gl: WebGL2RenderingContext): boolean {
  let name = String(gl.getParameter(gl.RENDERER) ?? '');
  if (/^WebKit WebGL$/i.test(name)) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
  }
  return /SwiftShader|llvmpipe|softpipe|Software/i.test(name);
}

export const isTyping = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
