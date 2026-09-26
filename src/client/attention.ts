import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { callDiff, titleFor } from '../core/attention';
import { MESSAGE_CUE, joinCue, leaveCue } from '../core/cue';
import { armSound, playCue } from './sound';
import { getPicture } from './invite';
import type { createRoom } from './room';
import type { createCall } from './call';
import { exposeHooks } from './hooks';

/** One room this browser is connected to, with its call. The list changes as rooms are added and left. */
export type RoomLink = { room: ReturnType<typeof createRoom>; call: ReturnType<typeof createCall> };

/**
 * Attention cues (spec §7.4) and the screen wake lock (spec §6.5) across every room: title badge while
 * the window is unfocused, quiet chimes when others join or leave a call, each friend's own, a tick for messages, and the
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
  /** Profile pictures by participant tag; a leaver is gone from presence, so theirs is read from the previous snapshot. */
  const pictures = () => new Map(links().flatMap((l) => l.room.people().map((p) => [tag(l.room.roomId, p.publicKey), p.picture] as const)));
  /** Rooms whose first real snapshot (one that includes me) has arrived; nothing before it is a join. */
  const seeded = () => new Set(links().filter((l) => l.room.people().some((p) => p.publicKey === myKey)).map((l) => l.room.roomId));

  // ---- title badge
  createEffect(() => titleFor(others().size, unfocused()), (title) => { document.title = title; });

  // ---- chimes: each friend's own cue from their profile picture (ticket 23)
  const disarm = armSound();
  createEffect(
    // Everything reactive is read here, in the compute phase; the apply phase only acts on the snapshot.
    () => ({ now: others(), seeded: seeded(), held: held(), pictures: pictures() }),
    ({ now, seeded, held, pictures }, prev) => {
      if (!prev) return;
      // Only rooms that were seeded before and still are can report a join or a leave.
      const settled = (t: string) => { const roomId = t.slice(0, t.indexOf(' ')); return seeded.has(roomId) && prev.seeded.has(roomId); };
      const before = new Set([...prev.now].filter(settled));
      const after = new Set([...now].filter(settled));
      const { joined, left } = callDiff(before, after, '', held); // I am already left out of both sets
      for (const t of joined) playCue(joinCue(pictures.get(t)));
      for (const t of left) playCue(leaveCue(prev.pictures.get(t)));
    },
  );

  // My own join and leave play my own cue, so I know what the others hear. Read from the call's own state, not presence:
  // a server reconnect keeps me in the call and must not sound like leaving and coming back.
  createEffect(() => links().filter((l) => l.call.inCall()).map((l) => l.room.roomId), (now, prev) => {
    if (!prev) return;
    if (now.some((id) => !prev.includes(id))) playCue(joinCue(getPicture()));
    if (prev.some((id) => !now.includes(id))) playCue(leaveCue(getPicture()));
  });

  // ---- incoming text: a soft tick for other people's messages in any room, never your own or restored history (ticket 09)
  let cues = 0;
  createEffect(() => links().map((l) => l.room), (rooms) => {
    const stops = rooms.map((room) => room.onText(() => { cues++; playCue(MESSAGE_CUE); }));
    return () => { for (const stop of stops) stop(); };
  });
  if (exposeHooks) (window as unknown as { __daveCues?: () => number }).__daveCues = () => cues;

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
    disarm();
    document.removeEventListener('visibilitychange', syncWakeLock);
    void sentinel?.release();
    document.title = titleFor(0, false);
  });
}
