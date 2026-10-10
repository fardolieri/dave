import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { callDiff, sharesStarted, titleFor } from '../core/attention';
import { MESSAGE_CUE, joinCue, leaveCue, shareCue, type Cue } from '../core/cue';
import { armSound, playCue } from './sound';
import { getPicture } from './invite';
import type { createRoom } from './room';
import type { createCall } from './call';
import { exposeHooks } from './hooks';

/** One room this browser is connected to, with its call. The list changes as rooms are added and left. */
export type RoomLink = { room: ReturnType<typeof createRoom>; call: ReturnType<typeof createCall> };

/**
 * Attention cues (spec §7.4) and the screen wake lock (spec §6.5) across every room: title badge while
 * the window is unfocused, quiet chimes when others join or leave a call or start sharing, each friend's own, a tick for
 * messages, and the screen kept awake while watching a share or, on a phone, while in a call. Platform state (focus,
 * visibility) is mirrored into a signal once; everything else derives from room and call signals.
 */
export function createAttention(links: () => RoomLink[], myKey: string): void {
  const [unfocused, setUnfocused] = createSignal(document.hidden || !document.hasFocus());
  const syncFocus = () => setUnfocused(document.hidden || !document.hasFocus());
  document.addEventListener('visibilitychange', syncFocus);
  window.addEventListener('focus', syncFocus);
  window.addEventListener('blur', syncFocus);

  // Participants are keyed per room, so a friend in two calls at once counts twice: two things are happening.
  const tag = (roomId: string, publicKey: string) => `${roomId} ${publicKey}`;
  const participants = (except?: string) => new Set(links().flatMap((l) => l.room.people().filter((p) => p.role === 'participant' && p.publicKey !== except).map((p) => tag(l.room.roomId, p.publicKey))));
  const inCall = () => participants();
  const others = () => participants(myKey);
  const sharers = () => new Set(links().flatMap((l) => l.room.people().filter((p) => p.role === 'participant' && p.sharing && p.publicKey !== myKey).map((p) => tag(l.room.roomId, p.publicKey))));
  /**
   * Friends I still hold a peer connection to. Read straight from the connections, not from `serverLost`: the call sets
   * that flag in its own effect on the same presence, after this one has already seen the friend gone (report of Oct 8).
   */
  const kept = () => new Set(links().flatMap((l) => l.call.views().map((v) => tag(l.room.roomId, v.publicKey))));
  /** Rooms whose call I am in. My own leave closes every connection, which is no leave of theirs. */
  const calling = () => new Set(links().filter((l) => l.call.inCall()).map((l) => l.room.roomId));
  /** Profile pictures by participant tag; a leaver is gone from presence, so theirs is read from an earlier snapshot. */
  const pictures = () => new Map(links().flatMap((l) => l.room.people().map((p) => [tag(l.room.roomId, p.publicKey), p.picture] as const)));
  /** Rooms whose first real snapshot (one that includes me) has arrived; nothing before it is a join. */
  const seeded = () => new Set(links().filter((l) => l.room.people().some((p) => p.publicKey === myKey)).map((l) => l.room.roomId));

  // ---- title badge: everyone in the call, you included, so a one-on-one reads "2 in call"
  createEffect(() => titleFor(inCall().size, unfocused()), (title) => { document.title = title; });

  // ---- chimes: each friend's own cue from their profile picture (ticket 23)
  const disarm = armSound();
  /** During a mic test (ticket 40) I hear nothing but myself, cues included. */
  const cue = (c: Cue) => { if (!untrack(() => links().some((l) => l.call.micTest() !== null))) playCue(c); };
  /** The last picture presence showed for each friend: one kept on a connection leaves after presence has let them go. */
  const lastPicture = new Map<string, string | undefined>();
  createEffect(
    // Everything reactive is read here, in the compute phase; the apply phase only acts on the snapshot.
    () => ({ now: others(), sharing: sharers(), seeded: seeded(), kept: kept(), calling: calling(), pictures: pictures() }),
    ({ now, sharing, seeded, kept, calling, pictures }, prev) => {
      if (!prev) return;
      // Only rooms that were seeded before and still are can report a join or a leave.
      const roomOf = (t: string) => t.slice(0, t.indexOf(' '));
      const settled = (t: string) => seeded.has(roomOf(t)) && prev.seeded.has(roomOf(t));
      // Connections count only in rooms whose call I was in before and still am.
      const held = (t: string) => settled(t) && calling.has(roomOf(t)) && prev.calling.has(roomOf(t));
      const before = new Set([...prev.now].filter(settled));
      const after = new Set([...now].filter(settled));
      const snapshot = (present: Set<string>, connected: Set<string>) => ({ present, kept: new Set([...connected].filter(held)) });
      const { joined, left } = callDiff(snapshot(before, prev.kept), snapshot(after, kept), ''); // I am already left out of every set
      for (const [t, picture] of prev.pictures) lastPicture.set(t, picture);
      for (const t of joined) cue(joinCue(pictures.get(t)));
      for (const t of left) cue(leaveCue(lastPicture.get(t)));
      for (const t of sharesStarted({ present: before, sharing: prev.sharing }, { sharing })) cue(shareCue(pictures.get(t)));
    },
  );

  // My own join and leave play my own cue, so I know what the others hear. Read from the call's own state, not presence:
  // a server reconnect keeps me in the call and must not sound like leaving and coming back.
  createEffect(() => links().filter((l) => l.call.inCall()).map((l) => l.room.roomId), (now, prev) => {
    if (!prev) return;
    if (now.some((id) => !prev.includes(id))) cue(joinCue(getPicture()));
    if (prev.some((id) => !now.includes(id))) cue(leaveCue(getPicture()));
  });
  // Starting my own share plays my share cue too, once the browser's picker has handed over the screen.
  createEffect(() => links().filter((l) => l.call.sharing() !== null).map((l) => l.room.roomId), (now, prev) => {
    if (prev && now.some((id) => !prev.includes(id))) cue(shareCue(getPicture()));
  });

  // ---- incoming text: a soft tick for other people's messages in any room, never your own or restored history (ticket 09)
  let cues = 0;
  createEffect(() => links().map((l) => l.room), (rooms) => {
    const stops = rooms.map((room) => room.onText(() => { cues++; cue(MESSAGE_CUE); }));
    return () => { for (const stop of stops) stop(); };
  });
  if (exposeHooks) (window as unknown as { __daveCues?: () => number }).__daveCues = () => cues;

  // ---- wake lock while watching at least one live share, or while in a call on a touch device: a phone that
  // dims to black mid-call drops the call (report of Sep 23). Serialised so overlapping triggers cannot double-request.
  let sentinel: WakeLockSentinel | null = null;
  let wakeChain: Promise<void> = Promise.resolve();
  const touch = matchMedia('(pointer: coarse)').matches;
  const wantLock = () => links().some((l) => (touch && l.call.inCall()) || l.call.views().some((v) => v.watching && v.shareLive)) && !document.hidden;
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
