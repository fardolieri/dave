/**
 * Invariants (quality ticket 04): what the UI says against what the WebRTC stack and the call state say. The call reads
 * its facts every INVARIANT_EVERY_MS (client/invariants.ts); the rules here name what contradicts, and the watch reports a
 * contradiction once it has held for its grace period, once per kind per call. Transitions are legal for a moment, so a
 * breach missing from one reading starts over: a false alarm is worse than a miss.
 */

export type InvariantKind =
  /** A share tile says "Opening…" while its video decodes frames (problem report of Oct 3). */
  | 'share_opening'
  /** A friend's voice plays louder or quieter than their volume control says (or not silenced during a mic test). */
  | 'voice_gain'
  /** The same for their share's sound, against their volume and the share's own volume (problem report of Oct 3). */
  | 'share_gain'
  /** A badge says "direct" or "via relay" for a connection whose transport has failed or closed. */
  | 'conn_transport'
  /**
   * An attachment shows a pull under way, and none is running or waiting its turn, or the one running has had nothing
   * for longer than a pull gives itself (report of 2026-10-16: "Try again keeps being at 0%"). Attachments ticket 04.
   */
  | 'file_pulling_stuck'
  /** An attachment says it waits for someone to come online while a friend who has it is online. */
  | 'file_waiting_online';

export const INVARIANT_EVERY_MS = 2_000;
/**
 * How long a breach must hold before it counts. A tile turns live on the track's unmute or on the next 2 s stats read;
 * a gain is set in the same task as its control, except a master volume change, which waits for a microphone reopen; a
 * badge follows the ICE state in the same event.
 */
export const INVARIANT_GRACE_MS: Record<InvariantKind, number> = {
  share_opening: 10_000,
  voice_gain: 6_000,
  share_gain: 6_000,
  conn_transport: 10_000,
  // A pull's status and its bookkeeping change in the same task; what a stuck pull adds is PULL_QUIET_MS.
  file_pulling_stuck: 10_000,
  // A friend coming online starts the pull in the same presence update.
  file_waiting_online: 10_000,
};

/** What a share tile shows (App.tsx ShareTile reads it from here too, so the watch sees what the tile shows). */
export type ShareTileState = 'own' | 'locked' | 'unreachable' | 'closed' | 'opening' | 'live';
export function shareTileState(isMe: boolean, inCall: boolean, view: { conn: string; watching: boolean; shareLive: boolean } | undefined): ShareTileState {
  if (isMe) return 'own';
  if (!inCall) return 'locked';
  if (view?.conn === 'unreachable') return 'unreachable';
  if (!view?.watching) return 'closed';
  return view.shareLive ? 'live' : 'opening';
}

/** What a friend's voice or share gain node is set to: master times their volume, for the share also its own volume; nothing during a mic test. */
export function gainFor(kind: 'voice' | 'share', c: { master: number; volume: number; shareVolume: number; micTest: boolean }): number {
  return c.micTest ? 0 : c.master * c.volume * (kind === 'share' ? c.shareVolume : 1);
}

/** One friend in the call as the UI shows them and as the browser has them. No names: `key` only identifies them within this tab. */
export type PeerFacts = {
  key: string;
  /** The view the badge, the volume control and the share tile render from. */
  conn: string; watching: boolean; shareLive: boolean; volume: number; shareVolume: number;
  /** Their presence entry says they share: a tile is on screen for them. */
  sharing: boolean;
  /** The gain nodes as set, null until that audio arrives. */
  voiceGain: number | null; shareGain: number | null;
  /** When the stats reads last saw the share video's frames decoded grow; null if they never did. */
  framesGrewAt: number | null;
  connection: string; ice: string;
};
/** Read at `at`: the master volume, whether a mic test runs (it silences everyone), every peer. */
export type CallFacts = { at: number; master: number; micTest: boolean; peers: PeerFacts[] };
export type Breach = { kind: InvariantKind; key: string };

/** Gain nodes hold 32-bit floats: 0.35 reads back as 0.3499999940395355. */
const GAIN_TOLERANCE = 1e-3;
const DEAD = new Set(['failed', 'closed']);
/**
 * Frames that grew this recently mean the video decodes. Wider than the 2 s between stats reads, so a read that lands
 * late, or a still screen that sends a frame now and then, does not break a run.
 */
export const DECODING_RECENT_MS = 5_000;

/** Every contradiction in `now`. */
export function breaches(now: CallFacts): Breach[] {
  const out: Breach[] = [];
  for (const p of now.peers) {
    const decoding = p.framesGrewAt !== null && now.at - p.framesGrewAt <= DECODING_RECENT_MS;
    if (p.sharing && decoding && shareTileState(false, true, p) === 'opening') out.push({ kind: 'share_opening', key: p.key });
    const controls = { master: now.master, micTest: now.micTest, volume: p.volume, shareVolume: p.shareVolume };
    if (p.voiceGain !== null && Math.abs(p.voiceGain - gainFor('voice', controls)) > GAIN_TOLERANCE) out.push({ kind: 'voice_gain', key: p.key });
    if (p.shareGain !== null && Math.abs(p.shareGain - gainFor('share', controls)) > GAIN_TOLERANCE) out.push({ kind: 'share_gain', key: p.key });
    if ((p.conn === 'direct' || p.conn === 'relayed') && (DEAD.has(p.connection) || DEAD.has(p.ice))) out.push({ kind: 'conn_transport', key: p.key });
  }
  return out;
}

export type Violation = Breach & { heldMs: number };

/**
 * Follows breaches from reading to reading. `feed` returns those that have now held for their grace period, each kind
 * once until `reset` (a new call). A breach missing from a reading starts over, and so does everything after a gap
 * between readings longer than `maxGapMs`: a throttled background tab or a stalled machine ran nothing in between,
 * neither the check nor what would have set things right.
 */
export function createInvariantWatch(grace: Record<InvariantKind, number> = INVARIANT_GRACE_MS, maxGapMs = 3 * INVARIANT_EVERY_MS) {
  /** When each breach, by kind and peer, was first seen in an unbroken run of readings. */
  let since = new Map<string, number>();
  let lastAt: number | null = null;
  const reported = new Set<InvariantKind>();
  return {
    feed(at: number, current: Breach[]): Violation[] {
      const fresh = lastAt === null || at - lastAt > maxGapMs;
      lastAt = at;
      const next = new Map<string, number>();
      const due: Violation[] = [];
      for (const b of current) {
        const id = `${b.kind} ${b.key}`;
        const first = (fresh ? undefined : since.get(id)) ?? at;
        next.set(id, first);
        if (at - first >= grace[b.kind] && !reported.has(b.kind)) {
          reported.add(b.kind);
          due.push({ ...b, heldMs: at - first });
        }
      }
      since = next;
      return due;
    },
    /** A new call: nothing seen so far counts, and every kind may be reported again. */
    reset(): void { since = new Map(); lastAt = null; reported.clear(); },
  };
}

/**
 * One attachment of a room as the chat shows it and as the pulls have it (client/room.ts). No names, no hashes: `key`
 * only tells the attachments of this room apart.
 */
export type FileFacts = {
  key: string;
  /** What the chat shows (client/room.ts, Attachment). */
  status: 'idle' | 'waiting' | 'pulling' | 'ready' | 'failed';
  /** A pull of it is running, or queued for its turn. */
  running: boolean;
  /** A pull of it is running, not only queued. */
  active: boolean;
  /** When the running pull started or last received bytes; null with none. */
  movedAt: number | null;
  /** A friend who has it, other than me, is online. */
  holderOnline: boolean;
};
/** Read at `at`: every attachment of the room that has a status. */
export type RoomFacts = { at: number; files: FileFacts[] };

/**
 * How long a running pull may be quiet: until its channel opens, the ICE servers' wait (5 s) and its connect timeout
 * (20 s) add up to 25 s; after, any frame within its stall timeout (20 s). The room counts the channel opening and every
 * frame as a sign of life (client/room.ts, `moved`). Quiet for longer, the pull should have ended.
 */
export const PULL_QUIET_MS = 30_000;

/** Every contradiction among a room's attachments. */
export function fileBreaches(now: RoomFacts): Breach[] {
  const out: Breach[] = [];
  for (const f of now.files) {
    if (f.status === 'pulling' && (!f.running || (f.active && f.movedAt !== null && now.at - f.movedAt > PULL_QUIET_MS))) out.push({ kind: 'file_pulling_stuck', key: f.key });
    if (f.status === 'waiting' && f.holderOnline) out.push({ kind: 'file_waiting_online', key: f.key });
  }
  return out;
}
