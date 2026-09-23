// Share, audio, and viewer settings (spec §6.1, §6.3, §6.4): plain data, defaults,
// and the WebRTC parameters derived from them. Runtime-neutral so it can be unit-tested.
import { SHARE_BUDGET_BPS, SHARE_CEILING_BPS, perViewerBitrate } from './mesh';

export type Degradation = 'balanced' | 'maintain-framerate' | 'maintain-resolution';
export type FrameRate = 15 | 30 | 60;
/** Maximum height in pixels; 0 means native. */
export type MaxHeight = 0 | 1080 | 720;

export type ShareSettings = {
  frameRate: FrameRate;
  maxHeight: MaxHeight;
  degradation: Degradation;
  /** Sharer upload budget across all viewers, bits per second. */
  budgetBps: number;
  /** Per-viewer ceiling, bits per second. */
  ceilingBps: number;
};

// Browsers and documents out of the box: sharp text at native resolution, 30 fps. Game streams turn the
// frame rate up and the resolution down themselves; there are no named profiles.
export const DEFAULT_SHARE: ShareSettings = { frameRate: 30, maxHeight: 0, degradation: 'maintain-resolution', budgetBps: SHARE_BUDGET_BPS, ceilingBps: SHARE_CEILING_BPS };

export function withChange(s: ShareSettings, change: Partial<ShareSettings>): ShareSettings {
  return { ...s, ...change };
}

/** Structural subset of MediaTrackConstraints, so this module needs no DOM types. */
export type TrackConstraints = { frameRate: { ideal: number; max: number }; height?: { max: number } };

/** Track constraints for the live display-capture track (applied with applyConstraints). */
export function trackConstraints(s: ShareSettings): TrackConstraints {
  const c: TrackConstraints = { frameRate: { ideal: s.frameRate, max: s.frameRate } };
  if (s.maxHeight) c.height = { max: s.maxHeight };
  return c;
}

/** The encoder's content hint follows the degradation choice: framerate-first means motion, anything else is detail. */
export function contentHint(s: ShareSettings): 'detail' | 'motion' {
  return s.degradation === 'maintain-framerate' ? 'motion' : 'detail';
}

/** Per-viewer encoding for one connection: active follows their subscription, bitrate the budget split, scale their request. */
export function shareEncoding(s: ShareSettings, viewers: number, viewerScale: number): { maxBitrate: number; maxFramerate: number; scaleResolutionDownBy: number; degradationPreference: Degradation } {
  return {
    maxBitrate: perViewerBitrate(viewers, s.budgetBps, s.ceilingBps),
    maxFramerate: s.frameRate,
    scaleResolutionDownBy: Math.max(1, viewerScale),
    degradationPreference: s.degradation,
  };
}

export type AudioSettings = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Device ids; empty means the browser default. */
  microphoneId: string;
  speakerId: string;
  /** Master volume for everyone's voice and share audio, 0 to MAX_VOLUME; multiplied with each participant's local volume. */
  masterVolume: number;
};
export const DEFAULT_AUDIO: AudioSettings = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, microphoneId: '', speakerId: '', masterVolume: 1 };
export const processingIsDefault = (a: AudioSettings): boolean => a.echoCancellation && a.noiseSuppression && a.autoGainControl;

export type ViewerSettings = {
  /** Low latency: a small jitter buffer target in ms on share receivers; 0 means browser default. */
  jitterBufferTargetMs: number;
};
export const DEFAULT_VIEWER: ViewerSettings = { jitterBufferTargetMs: 0 };
export const LOW_LATENCY_MS = 100;

type Validators<T> = Partial<{ [K in keyof T]: (v: unknown) => v is T[K] }>;
const oneOf = <V,>(...allowed: readonly V[]) => (v: unknown): v is V => allowed.includes(v as V);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Parse a stored JSON blob against defaults: unknown fields are dropped, ill-typed or invalid fields fall back to the default. */
export function parseSettings<T extends object>(defaults: T, raw: string | null, valid: Validators<T> = {}): T {
  if (!raw) return defaults;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...defaults } as Record<string, unknown>;
    for (const k of Object.keys(defaults) as Array<keyof T & string>) {
      if (!(k in v)) continue;
      const check = valid[k] as ((x: unknown) => boolean) | undefined;
      const ok = check ? check(v[k]) : typeof v[k] === typeof (defaults as Record<string, unknown>)[k];
      if (ok) out[k] = v[k];
    }
    return out as T;
  } catch {
    return defaults;
  }
}

export const parseShareSettings = (raw: string | null): ShareSettings =>
  parseSettings(DEFAULT_SHARE, raw, {
    frameRate: oneOf<FrameRate>(15, 30, 60),
    maxHeight: oneOf<MaxHeight>(0, 1080, 720),
    degradation: oneOf<Degradation>('balanced', 'maintain-framerate', 'maintain-resolution'),
    budgetBps: positive,
    ceilingBps: positive,
  });
export const parseAudioSettings = (raw: string | null): AudioSettings =>
  parseSettings(DEFAULT_AUDIO, raw, { masterVolume: (v): v is number => typeof v === 'number' && clampVolume(v) === v });
export const parseViewerSettings = (raw: string | null): ViewerSettings =>
  parseSettings(DEFAULT_VIEWER, raw, { jitterBufferTargetMs: (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 });

/** Turn a typed-in megabit value into bits per second, clamped; NaN or nonsense keeps the previous value. */
export function mbpsToBps(input: string, previousBps: number, minMbps: number, maxMbps: number): number {
  if (input.trim() === '') return previousBps; // Number('') is 0, not NaN
  const n = Number(input);
  if (!Number.isFinite(n)) return previousBps;
  return Math.round(Math.min(maxMbps, Math.max(minMbps, n)) * 1_000_000);
}

/** Shared with the CSS breakpoint in styles.css (700px): phones ask for downscaled shares and stack the layout. */
export const SMALL_SCREEN_QUERY = '(max-width: 700px)';

/** Local per-participant volume (spec §6.1 addition): 0 to MAX_VOLUME (200 percent), default 1. Clamps anything else. */
export const MAX_VOLUME = 2;
export function clampVolume(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_VOLUME, Math.max(0, n));
}

/** Parse the stored volume map (public key to volume), dropping junk. */
export function parseVolumes(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    if (typeof v === 'object' && v !== null) for (const [k, val] of Object.entries(v)) if (typeof val === 'number') out[k] = clampVolume(val);
    return out;
  } catch {
    return {};
  }
}
