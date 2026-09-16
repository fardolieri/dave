import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { CHIME, callDiff, titleFor } from '../core/attention';
import type { createRoom } from './room';
import type { createCall } from './call';

/** One room this browser is connected to, with its call. The list changes as rooms are added and left. */
export type RoomLink = { room: ReturnType<typeof createRoom>; call: ReturnType<typeof createCall> };

/**
 * Attention cues (spec §7.4) and the screen wake lock (spec §6.5) across every room: title badge while
 * the window is unfocused, quiet chimes when others join or leave a call, a tick for messages, and the
 * screen kept awake while watching a share. Platform state (focus, visibility) is mirrored into a
 * signal once; everything else derives from room and call signals.
 */
export function createAttention(links: () => RoomLink[], myKey: string): void {
  const [unfocused, setUnfocused] = createSignal(document.hidden || !document.hasFocus());
  const syncFocus = () => setUnfocused(document.hidden || !document.hasFocus());
  document.addEventListener('visibilitychange', syncFocus);
  window.addEventListener('focus', syncFocus);
  window.addEventListener('blur', syncFocus);

  // Participants are keyed per room, so a friend in two calls at once counts twice: two things are happening.
  const tag = (roomId: string, publicKey: string) => `${roomId} ${publicKey}`;
  const others = () => new Set(links().flatMap((l) => l.room.people().filter((p) => p.role === 'participant' && p.publicKey !== myKey).map((p) => tag(l.room.roomId, p.publicKey))));
  const held = () => new Set(links().flatMap((l) => l.call.views().filter((v) => v.serverLost).map((v) => tag(l.room.roomId, v.publicKey))));
  /** Rooms whose first real snapshot (one that includes me) has arrived; nothing before it is a join. */
  const seeded = () => new Set(links().filter((l) => l.room.people().some((p) => p.publicKey === myKey)).map((l) => l.room.roomId));

  // ---- title badge
  createEffect(() => titleFor(others().size, unfocused()), (title) => { document.title = title; });

  // ---- chimes: browsers only let audio start after a gesture, so the context is created lazily on first interaction.
  // The unlock listens for `click`, not `pointerdown`, and unregisters once the context runs. Brave with autoplay
  // set to Block clears the page's user activation whenever the autoplay policy is consulted, and creating or
  // resuming an AudioContext consults it: an unlock on pointerdown robbed the click handler that followed, a share
  // tile's play(), of the gesture it needs, and the tile stayed black (reproduced in headless Brave, Sep 10).
  let ctx: AudioContext | null = null;
  const stopUnlocking = () => { window.removeEventListener('click', unlock); window.removeEventListener('keydown', unlock); };
  function unlock(): void {
    ctx ??= new AudioContext();
    if (ctx.state === 'running') { stopUnlocking(); return; }
    ctx.resume().then(() => { if (ctx?.state === 'running') stopUnlocking(); }, () => {});
  }
  window.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock);
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
  createEffect(
    // Everything reactive is read here, in the compute phase; the apply phase only acts on the snapshot.
    () => ({ now: others(), seeded: seeded(), held: held() }),
    ({ now, seeded, held }, prev) => {
      if (!prev) return;
      // Only rooms that were seeded before and still are can report a join or a leave.
      const settled = (t: string) => { const roomId = t.slice(0, t.indexOf(' ')); return seeded.has(roomId) && prev.seeded.has(roomId); };
      const before = new Set([...prev.now].filter(settled));
      const after = new Set([...now].filter(settled));
      const { joined, left } = callDiff(before, after, '', held); // I am already left out of both sets
      if (joined.length) chime(CHIME.join);
      else if (left.length) chime(CHIME.leave);
    },
  );

  // ---- incoming text: a soft tick for other people's messages in any room, never your own or restored history (ticket 09)
  let cues = 0;
  createEffect(() => links().map((l) => l.room), (rooms) => {
    const stops = rooms.map((room) => room.onText(() => { cues++; chime(CHIME.message, CHIME.messageGain); }));
    return () => { for (const stop of stops) stop(); };
  });
  if (import.meta.env.DEV) (window as unknown as { __daveCues?: () => number }).__daveCues = () => cues;

  // ---- wake lock while watching at least one live share, serialised so overlapping triggers cannot double-request
  let sentinel: WakeLockSentinel | null = null;
  let wakeChain: Promise<void> = Promise.resolve();
  const wantLock = () => links().some((l) => l.call.views().some((v) => v.watching && v.shareLive)) && !document.hidden;
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
    document.removeEventListener('visibilitychange', syncFocus);
    window.removeEventListener('focus', syncFocus);
    window.removeEventListener('blur', syncFocus);
    stopUnlocking();
    document.removeEventListener('visibilitychange', syncWakeLock);
    void sentinel?.release();
    void ctx?.close();
    document.title = titleFor(0, false);
  });
}
