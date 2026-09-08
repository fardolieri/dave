/**
 * Keeps the last console warnings and errors of this tab so a problem report can carry them.
 * Installed once at startup; the originals still print.
 */
export type LogEntry = { at: number; level: 'warn' | 'error'; text: string };
const MAX_ENTRIES = 40;
const entries: LogEntry[] = [];

const render = (args: unknown[]): string => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 300);
const safeJson = (v: unknown): string => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const push = (level: LogEntry['level'], args: unknown[]): void => {
  entries.push({ at: Date.now(), level, text: render(args) });
  if (entries.length > MAX_ENTRIES) entries.shift();
};

export function installConsoleBuffer(): void {
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => { push(level, args); original(...args); };
  }
  window.addEventListener('error', (e) => push('error', [e.message]));
  window.addEventListener('unhandledrejection', (e) => push('error', ['unhandled rejection:', e.reason]));
}

export const recentLog = (): LogEntry[] => entries.slice();
