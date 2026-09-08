import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { CHIME, callDiff, titleFor } from '../core/attention';
import type { createRoom } from './room';
import type { createCall } from './call';

/**
 * Attention cues (spec §7.4) and the screen wake lock (spec §6.5): title badge while the window is
 * unfocused, quiet chimes when others join or leave the Call, and the screen kept awake while
 * watching a share. Platform state (focus, visibility) is mirrored into a signal once; everything
 * else derives from room and call signals.
 */
export function createAttention(room: ReturnType<typeof createRoom>, call: ReturnType<typeof createCall>, myKey: string): void {
  const [unfocused, setUnfocused] = createSignal(document.hidden || !document.hasFocus());
  const syncFocus = () => setUnfocused(document.hidden || !document.hasFocus());
  document.addEventListener('visibilitychange', syncFocus);
  window.addEventListener('focus', syncFocus);
  window.addEventListener('blur', syncFocus);

  const participants = () => new Set(room.people().filter((p) => p.role === 'participant').map((p) => p.publicKey));
  const othersInCall = () => [...participants()].filter((k) => k !== myKey).length;
  const held = () => new Set(call.views().filter((v) => v.serverLost).map((v) => v.publicKey));

  // ---- title badge
  createEffect(() => titleFor(othersInCall(), unfocused()), (title) => { document.title = title; });

  // ---- chimes: browsers only let audio start after a gesture, so the context is created lazily on first interaction
  let ctx: AudioContext | null = null;
  const unlock = () => { ctx ??= new AudioContext(); void ctx.resume(); };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
  function chime(notes: readonly number[], gainLevel: number = CHIME.gain): void {
    const c = ctx;
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime;
    notes.forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * CHIME.noteSeconds;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(gainLevel, start + 0.01);
      gain.gain.linearRampToValueAtTime(0, start + CHIME.noteSeconds);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + CHIME.noteSeconds + 0.01);
    });
  }
  // The first real snapshot (one that includes me) is the baseline; nothing before it is a join.
  createEffect(
    // Everything reactive is read here, in the compute phase; the apply phase only acts on the snapshot.
    () => ({ now: participants(), seeded: room.people().some((p) => p.publicKey === myKey), held: held() }),
    ({ now, seeded, held }, prev) => {
      if (!seeded || !prev?.seeded) return;
      const { joined, left } = callDiff(prev.now, now, myKey, held);
      if (joined.length) chime(CHIME.join);
      else if (left.length) chime(CHIME.leave);
    },
  );

  // ---- incoming text: a soft tick for other people's messages, never your own or restored history (ticket 09)
  let cues = 0;
  const stopText = room.onText(() => { cues++; chime(CHIME.message, CHIME.messageGain); });
  if (import.meta.env.DEV) (window as unknown as { __daveCues?: () => number }).__daveCues = () => cues;

  // ---- wake lock while watching at least one live share, serialised so overlapping triggers cannot double-request
  let sentinel: WakeLockSentinel | null = null;
  let wakeChain: Promise<void> = Promise.resolve();
  const wantLock = () => call.views().some((v) => v.watching && v.shareLive) && !document.hidden;
  async function syncWakeLockNow(): Promise<void> {
    const wl = navigator.wakeLock;
    if (!wl) return;
    const want = untrack(wantLock); // a one-time snapshot: this runs outside any tracking scope on purpose
    if (want && !sentinel) {
      try {
        const s = await wl.request('screen');
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
        sentinel = s;
        if (!untrack(wantLock)) { await s.release().catch(() => {}); sentinel = null; } // state changed during the request
      } catch { /* denied or unsupported */ }
    } else if (!want && sentinel) {
      const s = sentinel;
      sentinel = null;
      await s.release().catch(() => {});
    }
  }
  const syncWakeLock = () => { wakeChain = wakeChain.then(syncWakeLockNow); };
  createEffect(() => wantLock(), syncWakeLock);
  document.addEventListener('visibilitychange', syncWakeLock);

  onCleanup(() => {
    stopText();
    document.removeEventListener('visibilitychange', syncFocus);
    window.removeEventListener('focus', syncFocus);
    window.removeEventListener('blur', syncFocus);
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    document.removeEventListener('visibilitychange', syncWakeLock);
    void sentinel?.release();
    void ctx?.close();
    document.title = titleFor(0, false);
  });
}
