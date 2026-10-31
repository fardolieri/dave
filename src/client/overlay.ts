import { createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { layoutOverlay, overlayText, type Measure, type OverlayLayout, type OverlayModel } from '../core/overlay';
import { exposeHooks } from './hooks';

/**
 * The overlay: a room's list of friends in a picture-in-picture window, over other apps and tabs. Drawn onto a canvas
 * played as a video, as video is what picture-in-picture takes on every browser that has it, phones too (the Document
 * Picture-in-Picture API, real HTML in the window, is desktop only and puts a frame around it). Read only: nothing in it
 * can be clicked. One at a time, as the browser allows one picture-in-picture window per tab.
 */

type PipVideo = HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
type PipDoc = Document & { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
type CaptureCanvas = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };

/** Whether this browser can show the overlay: a page may ask for picture-in-picture of a video. */
export const overlaySupported: boolean = typeof document !== 'undefined' && (document as PipDoc).pictureInPictureEnabled === true
  && typeof (HTMLVideoElement.prototype as PipVideo).requestPictureInPicture === 'function'
  && typeof (HTMLCanvasElement.prototype as CaptureCanvas).captureStream === 'function';

/** Sharper than the window's CSS pixels: the window can be made larger than the overlay's size. */
const SCALE = 3;
/**
 * Painted again this often besides on every change, so a new look (a theme picked) shows in it, and the stream keeps
 * getting frames: a canvas stream makes one only when the canvas is painted.
 */
const REPAINT_MS = 1000;
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif';

const [openFor, setOpenFor] = createSignal<string | null>(null);
/** The room whose overlay is open, by id. */
export const overlayRoom = openFor;
let close: (() => void) | null = null;
let shown: OverlayLayout | null = null;
let video: HTMLVideoElement | null = null;

if (exposeHooks) (window as unknown as { __daveOverlay?: unknown }).__daveOverlay = () => (openFor() === null || !shown ? null : {
  room: openFor(), lines: overlayText(shown), pip: (document as PipDoc).pictureInPictureElement === video,
});

/** Puts the overlay away, if one is open. */
export function closeOverlay(): void {
  close?.();
}

/**
 * Opens the overlay of a room, in place of any open one: `model` is what it shows, kept up to date as it changes;
 * `look` the element whose theme it wears (the room's box). Called from a click: the browser opens picture-in-picture
 * only for one.
 */
export async function openOverlay(id: string, model: () => OverlayModel, look: () => Element | null): Promise<void> {
  closeOverlay();
  const canvas: CaptureCanvas = document.createElement('canvas');
  const g = canvas.getContext('2d')!;
  const el = document.createElement('video');
  // In the page but out of sight: Safari asks picture-in-picture of a video in the document
  el.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;opacity:0;pointer-events:none';
  el.muted = true; el.playsInline = true; el.setAttribute('aria-hidden', 'true');
  let last: OverlayModel = untrack(model);
  const paint = (m: OverlayModel) => { last = m; shown = draw(canvas, g, m, look()); };
  paint(last);
  const stream = canvas.captureStream!();
  el.srcObject = stream;
  document.body.append(el);
  let disposeRoot = () => {};
  const timer = setInterval(() => paint(last), REPAINT_MS);
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer); disposeRoot();
    el.removeEventListener('leavepictureinpicture', stop);
    if ((document as PipDoc).pictureInPictureElement === el) void (document as PipDoc).exitPictureInPicture?.().catch(() => {});
    for (const t of stream.getTracks()) t.stop();
    el.srcObject = null; el.remove();
    if (close === stop) { close = null; shown = null; video = null; setOpenFor(null); }
  };
  close = stop; video = el; setOpenFor(id);
  createRoot((dispose) => { disposeRoot = dispose; createEffect(model, paint); });
  el.addEventListener('leavepictureinpicture', stop);
  // The window's own pause button would freeze the list while it still looks live: it plays on
  el.addEventListener('pause', () => { if (!done) void el.play().catch(() => {}); });
  try {
    await el.play();
    if (done) return;
    await (el as PipVideo).requestPictureInPicture!();
    // Put away while the browser was opening it: nothing else would close the window
    if (done && (document as PipDoc).pictureInPictureElement === el) void (document as PipDoc).exitPictureInPicture?.().catch(() => {});
  } catch (e) {
    if (done) return;
    console.warn('The overlay could not open:', e);
    stop();
  }
}

/** Paints the overlay, the canvas sized to it, in the colours and fonts of the room's look. */
function draw(canvas: HTMLCanvasElement, g: CanvasRenderingContext2D, m: OverlayModel, look: Element | null): OverlayLayout {
  const css = look ? getComputedStyle(look) : null;
  const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
  const panel = v('--panel', '#1a1d24'), panel2 = v('--panel2', '#22262f'), fg = v('--fg', '#e6e8ee'), dim = v('--dim', '#8a90a0'), ok = v('--ok', '#3ddc84');
  const family = css?.fontFamily || 'system-ui, sans-serif';
  // The room's name as its box shows it, in the font, case and spacing of its look
  const titleEl = look?.querySelector('.room-title');
  const t = titleEl ? getComputedStyle(titleEl) : null;
  const titleFont = `${t?.fontStyle ?? 'normal'} ${t?.fontWeight ?? 'bold'} 12px ${t?.fontFamily || family}`;
  const titleCase = (s: string) => (t?.textTransform === 'uppercase' ? s.toUpperCase() : s);
  const spacing = t && t.letterSpacing !== 'normal' ? t.letterSpacing : '0px';
  const fonts = { title: titleFont, name: `14px ${family}`, tag: `italic 12px ${family}` };
  const spaced = g as CanvasRenderingContext2D & { letterSpacing?: string };
  const measure: Measure = (kind, text) => {
    g.font = fonts[kind];
    spaced.letterSpacing = kind === 'title' ? spacing : '0px';
    return g.measureText(kind === 'title' ? titleCase(text) : text).width;
  };
  const layout = layoutOverlay(m, measure);
  const w = layout.width * SCALE, h = layout.height * SCALE;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  g.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  g.fillStyle = panel; g.fillRect(0, 0, layout.width, layout.height);
  g.textBaseline = 'middle';
  for (const op of layout.ops) {
    spaced.letterSpacing = '0px';
    g.textAlign = 'left';
    if (op.kind === 'title') {
      g.font = fonts.title; spaced.letterSpacing = spacing; g.fillStyle = t?.color || dim;
      g.fillText(titleCase(op.text), op.x, op.y);
    } else if (op.kind === 'box') {
      // As the call box on the page: the call's green, faint
      g.save(); g.globalAlpha = 0.1; g.fillStyle = ok;
      g.beginPath(); g.roundRect(op.x, op.y, op.w, op.h, 8); g.fill(); g.restore();
    } else if (op.kind === 'face') {
      g.beginPath(); g.arc(op.cx, op.cy, op.r, 0, 2 * Math.PI); g.fillStyle = panel2; g.fill();
      if (op.speaking) { g.lineWidth = 2; g.strokeStyle = ok; g.beginPath(); g.arc(op.cx, op.cy, op.r + 1, 0, 2 * Math.PI); g.stroke(); }
      g.textAlign = 'center'; g.fillStyle = fg;
      g.font = op.pic ? `18px ${EMOJI_FONT}` : `600 13px ${family}`;
      g.fillText(op.text, op.cx, op.cy + (op.pic ? 1 : 0));
    } else if (op.kind === 'name') {
      g.font = fonts.name; g.fillStyle = fg; g.fillText(op.text, op.x, op.y);
    } else if (op.kind === 'tag') {
      g.font = fonts.tag; g.fillStyle = dim; g.textAlign = 'right'; g.fillText(op.text, op.right, op.y);
    } else {
      g.font = `13px ${family}`; g.fillStyle = dim; g.fillText(op.text, op.x, op.y);
    }
  }
  return layout;
}
