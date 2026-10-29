/** Rounded bitrate for captions: "850 kbps" below a megabit, "2.4 Mbps" above. */
export function formatBitrate(kbps: number): string {
  if (kbps < 1000) return `${Math.round(kbps)} kbps`;
  const mbps = kbps / 1000;
  return `${mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10} Mbps`;
}

export type VideoFormat = { width: number; height: number; fps: number };
/** "30 fps · 1280×720 · 2.4 Mbps", as a share's bar shows a stream; fps is rounded, zero fps (no frames yet) and an unknown format are left out. */
export function formatStream(kbps: number, f: VideoFormat | null): string {
  return [...(f && f.fps > 0 ? [`${Math.round(f.fps)} fps`] : []), ...(f ? [`${f.width}×${f.height}`] : []), formatBitrate(kbps)].join(' · ');
}
/** Distinct formats, largest first, so a sharer with viewers at different scales sees each once. */
export function distinctFormats(list: VideoFormat[]): VideoFormat[] {
  const seen = new Map<string, VideoFormat>();
  for (const f of list) if (f.width > 0 && f.height > 0) seen.set(`${f.width}x${f.height}@${Math.round(f.fps)}`, { ...f, fps: Math.round(f.fps) });
  return [...seen.values()].sort((a, b) => b.width * b.height - a.width * a.height || b.fps - a.fps);
}
