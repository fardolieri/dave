/** Rounded, human duration for the chat's reconnect note: "8 s", "3 min", "1 h 12 min", "2 d 3 h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const restMin = min % 60;
  if (h < 24) return restMin ? `${h} h ${restMin} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const restH = h % 24;
  return restH ? `${d} d ${restH} h` : `${d} d`;
}
