// The files this browser keeps (ADR 0006): bytes by SHA-256 in IndexedDB (`file:<hash>`), and an index of what is
// kept, oldest first (`files`), so the store stays within FILE_STORE_BUDGET. Shared by every room: a file announced in
// two rooms is kept once. Also the preview a sender makes of a picture or a video.
import { idbDelete, idbGet, idbSet } from './storage';
import { MAX_PREVIEW_LENGTH, PREVIEW_SIDE, inlineKind, keepWithin, parseFileIndex } from '../core/attachment';
import { toBase64Url } from '../core/identity';

export async function hashOf(blob: Blob): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())));
}

let chain: Promise<unknown> = Promise.resolve();
/** Writes to the index are serialised, like the history's. */
const serial = <T>(f: () => Promise<T>): Promise<T> => {
  const next = chain.then(f);
  chain = next.catch(() => undefined);
  return next;
};

/** Keeps a file whose hash was checked; the oldest others go if the budget needs it. Fails quietly: it is still shown. */
export function keepFile(hash: string, blob: Blob): Promise<void> {
  return serial(async () => {
    const { index, drop, kept } = keepWithin(parseFileIndex(await idbGet<unknown>('files')), { hash, size: blob.size, at: Date.now() });
    for (const h of drop) await idbDelete(`file:${h}`);
    if (kept) await idbSet(`file:${hash}`, blob);
    await idbSet('files', index);
  }).catch((e: unknown) => console.warn('keeping a file failed', e));
}

/**
 * Files sent from this page, as picked: a File reads from disk, so holding it costs little, and the sender can serve it
 * even when the store could not keep it (over the budget, or storage refused).
 */
const sent = new Map<string, Blob>();
export const holdSent = (hash: string, file: Blob): void => { sent.set(hash, file); };

/** A kept file's bytes, or null: the store's copy (on disk), else the one sent from this page. */
export async function keptFile(hash: string): Promise<Blob | null> {
  try {
    const blob = await idbGet<unknown>(`file:${hash}`);
    if (blob instanceof Blob) return blob;
  } catch { /* storage refused: the page's own copy, if any */ }
  return sent.get(hash) ?? null;
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));
const dataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** A frame of a video, a second in or less, and its size; null if the browser cannot play it. */
function videoFrame(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = () => { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
    const fail = () => { clearTimeout(timer); done(); resolve(null); };
    const timer = setTimeout(fail, 5000);
    video.muted = true;
    video.preload = 'auto';
    video.onerror = fail;
    video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 0) / 10); };
    video.onseeked = () => { clearTimeout(timer); resolve(video.videoWidth ? { source: video, width: video.videoWidth, height: video.videoHeight, done } : (done(), null)); };
    video.src = url;
  });
}

/**
 * The preview that goes with a picture or a video: at most PREVIEW_SIDE on its longest side, WebP where the browser
 * writes it, else JPEG, and the original's size. The original is not touched (ADR 0006). Null when there is none to make.
 */
export async function makePreview(file: Blob): Promise<{ preview?: string; width?: number; height?: number }> {
  const kind = inlineKind(file.type);
  if (!kind) return {};
  let frame: { source: CanvasImageSource; width: number; height: number; done: () => void } | null = null;
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file); // a GIF gives its first frame
      frame = { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
    } else frame = await videoFrame(file);
    if (!frame || !frame.width || !frame.height) return {};
    const scale = Math.min(1, PREVIEW_SIDE / Math.max(frame.width, frame.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    canvas.getContext('2d')!.drawImage(frame.source, 0, 0, canvas.width, canvas.height);
    const size = { width: frame.width, height: frame.height };
    for (const [type, quality] of [['image/webp', 0.6], ['image/jpeg', 0.6], ['image/jpeg', 0.3]] as const) {
      const blob = await canvasBlob(canvas, type, quality);
      // A browser that cannot write WebP writes PNG instead, which the announcement does not take.
      if (!blob || blob.type !== type) continue;
      const url = await dataUrl(blob);
      if (url.length <= MAX_PREVIEW_LENGTH) return { preview: url, ...size };
    }
    return size;
  } catch {
    return {};
  } finally {
    frame?.done();
  }
}
