// Share, audio, and viewer settings (spec §6.1, §6.3, §6.4): plain data, defaults, presets,
// and the WebRTC parameters derived from them. Runtime-neutral so it can be unit-tested.
import { SHARE_BUDGET_BPS, SHARE_CEILING_BPS, perViewerBitrate } from './mesh';

export type Degradation = 'balanced' | 'maintain-framerate' | 'maintain-resolution';
export type FrameRate = 15 | 30 | 60;
/** Maximum height in pixels; 0 means native. */
export type MaxHeight = 0 | 1080 | 720;

export type ShareSettings = {
  preset: 'detail' | 'motion' | 'custom';
  frameRate: FrameRate;
  maxHeight: MaxHeight;
  degradation: Degradation;
  /** Sharer upload budget across all viewers, bits per second. */
  budgetBps: number;
  /** Per-viewer ceiling, bits per second. */
  ceilingBps: number;
};

export const PRESETS: Record<'detail' | 'motion', Omit<ShareSettings, 'preset' | 'budgetBps' | 'ceilingBps'>> = {
  // Browsers and documents: sharp text, modest motion.
  detail: { frameRate: 30, maxHeight: 0, degradation: 'maintain-resolution' },
  // Game streams: smooth motion at reduced resolution.
  motion: { frameRate: 60, maxHeight: 720, degradation: 'maintain-framerate' },
};

export const DEFAULT_SHARE: ShareSettings = { preset: 'detail', ...PRESETS.detail, budgetBps: SHARE_BUDGET_BPS, ceilingBps: SHARE_CEILING_BPS };

export function applyPreset(s: ShareSettings, preset: 'detail' | 'motion'): ShareSettings {
  return { ...s, preset, ...PRESETS[preset] };
}

/** Any manual change leaves the preset unless it happens to match one exactly. */
export function withChange(s: ShareSettings, change: Partial<Omit<ShareSettings, 'preset'>>): ShareSettings {
  const next = { ...s, ...change };
  const matches = (Object.keys(PRESETS) as Array<'detail' | 'motion'>).find((k) => {
    const p = PRESETS[k];
    return p.frameRate === next.frameRate && p.maxHeight === next.maxHeight && p.degradation === next.degradation;
  });
  return { ...next, preset: matches ?? 'custom' };
}

/** Structural subset of MediaTrackConstraints, so this module needs no DOM types. */
export type TrackConstraints = { frameRate: { ideal: number; max: number }; height?: { max: number } };

/** Track constraints for the live display-capture track (applied with applyConstraints). */
export function trackConstraints(s: ShareSettings): TrackConstraints {
  const c: TrackConstraints = { frameRate: { ideal: s.frameRate, max: s.frameRate } };
  if (s.maxHeight) c.height = { max: s.maxHeight };
  return c;
}

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
};
export const DEFAULT_AUDIO: AudioSettings = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, microphoneId: '', speakerId: '' };
export const processingIsDefault = (a: AudioSettings): boolean => a.echoCancellation && a.noiseSuppression && a.autoGainControl;

export type ViewerSettings = {
  /** Low latency: a small jitter buffer target in ms on share receivers; 0 means browser default. */
  jitterBufferTargetMs: number;
};
export const DEFAULT_VIEWER: ViewerSettings = { jitterBufferTargetMs: 0 };
export const LOW_LATENCY_MS = 100;

/** Parse a stored JSON blob against defaults, ignoring unknown or ill-typed fields. */
export function parseSettings<T extends object>(defaults: T, raw: string | null): T {
  if (!raw) return defaults;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...defaults } as Record<string, unknown>;
    for (const k of Object.keys(defaults)) if (k in v && typeof v[k] === typeof (defaults as Record<string, unknown>)[k]) out[k] = v[k];
    return out as T;
  } catch {
    return defaults;
  }
}
