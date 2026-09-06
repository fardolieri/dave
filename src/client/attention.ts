import { createEffect, onCleanup } from 'solid-js';
import { CHIME, callDiff, titleFor } from '../core/attention';
import type { createRoom } from './room';
import type { createCall } from './call';

/**
 * Attention cues (spec §7.4) and the screen wake lock (spec §6.5): title badge while the tab is
 * unfocused, quiet chimes when others join or leave the Call, and the screen kept awake while
 * watching a share. Everything derives from the room and call signals.
 */
export function createAttention(room: ReturnType<typeof createRoom>, call: ReturnType<typeof createCall>, myKey: string): void {
  const participants = () => new Set(room.people().filter((p) => p.role === 'participant').map((p) => p.publicKey));
  const othersInCall = () => [...participants()].filter((k) => k !== myKey).length;

  // ---- title badge
  const applyTitle = () => { document.title = titleFor(othersInCall(), document.hidden); };
  createEffect(() => othersInCall(), applyTitle);
  document.addEventListener('visibilitychange', applyTitle);
  onCleanup(() => document.removeEventListener('visibilitychange', applyTitle));

  // ---- chimes: a browser only lets audio start after a gesture, so the context is created lazily on first interaction
  let ctx: AudioContext | null = null;
  const unlock = () => { ctx ??= new AudioContext(); void ctx.resume(); };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
  function chime(notes: readonly number[]): void {
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * CHIME.noteSeconds;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(CHIME.gain, start + 0.01);
      gain.gain.linearRampToValueAtTime(0, start + CHIME.noteSeconds);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(start);
      osc.stop(start + CHIME.noteSeconds + 0.01);
    });
  }
  let previous = participants();
  let seeded = false;
  createEffect(() => participants(), (now) => {
    if (seeded) {
      const { joined, left } = callDiff(previous, now, myKey);
      if (joined.length) chime(CHIME.join);
      else if (left.length) chime(CHIME.leave);
    }
    seeded = true;
    previous = now;
  });

  // ---- wake lock while watching at least one live share
  type WakeLockSentinel = { release(): Promise<void>; addEventListener(type: 'release', l: () => void): void };
  type WakeNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } };
  let sentinel: WakeLockSentinel | null = null;
  const watching = () => call.views().some((v) => v.watching && v.shareLive);
  async function syncWakeLock(): Promise<void> {
    const wl = (navigator as WakeNavigator).wakeLock;
    if (!wl) return;
    if (watching() && !document.hidden) {
      if (!sentinel) {
        try {
          sentinel = await wl.request('screen');
          sentinel.addEventListener('release', () => { sentinel = null; });
        } catch { /* denied or unsupported; nothing to do */ }
      }
    } else if (sentinel) {
      await sentinel.release().catch(() => {});
      sentinel = null;
    }
  }
  createEffect(() => watching(), () => void syncWakeLock());
  document.addEventListener('visibilitychange', () => void syncWakeLock());
  onCleanup(() => { void sentinel?.release(); });
}
