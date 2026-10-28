// How one connection to a friend recovers (ADR 0008): the table "Recovery rules" of spec §8.2, row by row. Events in,
// actions out; client/call.ts holds the browser objects and the timers, tells `step` what happened and carries out what
// it returns. `step` changes the link and the friend's counts in place. Pure, no imports beyond core.
import { failedRebuildDelay, ICE_DISCONNECTED_GRACE_MS, PEER_GRACE_MS, restartBackoff, stuckDelay } from './mesh';

export type Badge = 'connecting' | 'up' | 'reconnecting' | 'unreachable';
export type IceState = 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
export type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type Timer = 'watchdog' | 'disconnect' | 'restart' | 'rebuild' | 'grace';
/** Why a rebuild runs: the watchdog found it stuck (R11), or it failed before it ever connected (R9). */
export type RebuildWhy = 'stuck' | 'failed';

/** Per friend, across their connections: cleared when one comes up, when their socket is lost, when they leave, at my Leave. */
export type Counts = { stalled: number; rebuilds: number };
export const freshCounts = (): Counts => ({ stalled: 0, rebuilds: 0 });

/** One connection's recovery state. */
export type Link = {
  /** Built as the offerer: the watchdog of the other side waits a little longer. */
  initiator: boolean;
  /** The friend's stalled attempts when it was built: its watchdog's delay, and one more for its rebuild (R1, R11). */
  stalled: number;
  connectedOnce: boolean;
  badge: Badge;
  /** ICE restarts since it was last up: the restart back-off. */
  restarts: number;
  rebuild: 'none' | 'waiting' | 'running';
  /** The friend's socket is gone; the connection is kept while it works (ticket 31). */
  lost: boolean;
};

export type Action =
  | { do: 'badge'; badge: Badge }
  | { do: 'arm'; timer: Timer; ms: number }
  | { do: 'cancel'; timer: Timer }
  | { do: 'restart' }
  | { do: 'rebuild'; why: RebuildWhy; stalled: number }
  | { do: 'close' }
  /** R4: ask again for a watched share, read the stats. */
  | { do: 'up' }
  /** R14: send again what never reached them. */
  | { do: 'resend' }
  | { do: 'report'; event: 'peer_never_connected'; rebuilds: number };

export type Event =
  | { on: 'built' }
  | { on: 'ice'; ice: IceState; connection: ConnectionState }
  | { on: 'connection'; ice: IceState; connection: ConnectionState }
  | { on: 'timer'; timer: Timer; ice: IceState; connection: ConnectionState }
  /** O3: an offer of theirs was dropped; the rebuild runs now. */
  | { on: 'rebuild-now' }
  | { on: 'rebuilt'; why: RebuildWhy; done: boolean }
  | { on: 'lost'; ice: IceState }
  | { on: 'back' };

/** What a step needs to know about the call: whether presence makes me the one to offer to them first. */
export type Context = { iOfferFirst: boolean };

export function newLink(initiator: boolean, counts: Counts): Link {
  return { initiator, stalled: counts.stalled, connectedOnce: false, badge: 'connecting', restarts: 0, rebuild: 'none', lost: false };
}

export function step(link: Link, counts: Counts, event: Event, ctx: Context): Action[] {
  const out: Action[] = [];
  const badge = (b: Badge) => { if (link.badge !== b) { link.badge = b; out.push({ do: 'badge', badge: b }); } };
  const arm = (timer: Timer, ms: number) => out.push({ do: 'arm', timer, ms });
  const cancel = (timer: Timer) => out.push({ do: 'cancel', timer });

  /** F: no media can flow. */
  const failure = () => {
    if (link.lost) { out.push({ do: 'close' }); return; }
    badge('unreachable');
    if (!link.connectedOnce) {
      if (link.rebuild !== 'none') return;
      cancel('watchdog');
      link.rebuild = 'waiting';
      arm('rebuild', failedRebuildDelay(counts.rebuilds, ctx.iOfferFirst));
      return;
    }
    arm('restart', restartBackoff(link.restarts));
    link.restarts++;
  };
  /** R4. */
  const connected = () => {
    cancel('watchdog'); cancel('restart'); cancel('rebuild');
    link.rebuild = 'none';
    link.connectedOnce = true;
    counts.stalled = 0;
    counts.rebuilds = 0;
    badge('up');
    out.push({ do: 'up' });
  };
  /** R4 and R5, on the connection's state. */
  const onConnection = (ice: IceState, connection: ConnectionState) => {
    if (connection === 'failed' && ice !== 'failed') failure();
    else if (connection === 'connected') connected();
  };
  /** R9. */
  const rebuildFailed = () => {
    if (link.rebuild === 'running') return;
    cancel('rebuild');
    link.rebuild = 'running';
    out.push({ do: 'rebuild', why: 'failed', stalled: counts.stalled });
  };

  switch (event.on) {
    case 'built': // R1
      arm('watchdog', stuckDelay(link.stalled, link.initiator));
      break;
    case 'ice':
      cancel('disconnect');
      if (event.ice === 'connected' || event.ice === 'completed') { // R2
        link.restarts = 0;
        cancel('restart');
        onConnection(event.ice, event.connection);
      } else if (event.ice === 'disconnected') { // R3
        badge('reconnecting');
        arm('disconnect', ICE_DISCONNECTED_GRACE_MS);
      } else if (event.ice === 'failed') { // R5
        failure();
      } else if (event.ice === 'closed') { // R6
        badge('unreachable');
      }
      break;
    case 'connection':
      onConnection(event.ice, event.connection);
      break;
    case 'timer':
      switch (event.timer) {
        case 'disconnect': // R7
          if (event.ice !== 'disconnected') break;
          if (link.lost) out.push({ do: 'close' });
          else if (!link.connectedOnce) failure();
          else out.push({ do: 'restart' });
          break;
        case 'restart': // R8
          out.push({ do: 'restart' });
          break;
        case 'rebuild': // R9
          rebuildFailed();
          break;
        case 'watchdog': // R11
          if (link.badge === 'connecting' && event.connection !== 'closed') out.push({ do: 'rebuild', why: 'stuck', stalled: link.stalled + 1 });
          break;
        case 'grace': // R13
          if (event.connection !== 'connected') out.push({ do: 'close' });
          break;
      }
      break;
    case 'rebuild-now': // O3, then R9
      rebuildFailed();
      break;
    case 'rebuilt': // R10
      if (event.why !== 'failed') break;
      link.rebuild = 'none';
      if (event.done) {
        out.push({ do: 'report', event: 'peer_never_connected', rebuilds: counts.rebuilds });
        counts.rebuilds++;
      }
      break;
    case 'lost': // R12
      if (link.lost) break;
      counts.stalled = 0;
      counts.rebuilds = 0;
      if (event.ice === 'failed' || event.ice === 'closed' || event.ice === 'new') { out.push({ do: 'close' }); break; }
      link.lost = true;
      arm('grace', PEER_GRACE_MS);
      break;
    case 'back': // R14
      if (link.lost) { link.lost = false; cancel('grace'); }
      if (!link.connectedOnce && link.badge === 'unreachable' && link.rebuild === 'none') failure();
      else out.push({ do: 'resend' });
      break;
  }
  return out;
}

/**
 * Whether a rebuild decided earlier still applies once the fresh credentials came (R9, R11): the shell asks this after
 * any wait, as the connection may have come up, or the friend gone, meanwhile.
 */
export function stillRebuild(link: Link, why: RebuildWhy, connection: ConnectionState): boolean {
  return why === 'stuck' ? link.badge === 'connecting' && connection !== 'closed' : connection !== 'connected' && !link.lost;
}

/** What the shell knows about an incoming offer, for `offerPath`. */
export type OfferFacts = {
  /** I hold a connection to them. */
  held: boolean;
  /** It names a connection of mine (`forConn`), and that is not the one I hold. Without one held: it names one at all. */
  namesGone: boolean;
  /** It names no connection of mine (a first offer), mine holds no remote description and has a local one. */
  bothFirstOffers: boolean;
  /** Presence makes me the one to offer to them first; they offer first. Both false while either is unknown. */
  iOfferFirst: boolean;
  theyOfferFirst: boolean;
  /** A new DTLS certificate: they built a new connection (isFreshConnection). */
  fresh: boolean;
  /** A new ICE ufrag on the connection I hold: an ICE restart. */
  restartsIce: boolean;
  /** My connection's ICE failed. */
  iceFailed: boolean;
  /** My connection is closed. */
  closed: boolean;
};

/**
 * Where an offer of theirs goes (O1 to O5), and by which row: `drop`; `drop-rebuild` (O3: dropped, and mine rebuilt now,
 * R9); `fresh` (mine, if any, closed and the offer answered from a new one); `apply` (to mine, or to a new one if I hold
 * none).
 */
export function offerPath(link: Link | undefined, f: OfferFacts): { go: 'drop' | 'drop-rebuild' | 'fresh' | 'apply'; row: 'O1' | 'O2' | 'O3' | 'O4' | 'O5' } {
  if (f.namesGone && (f.held || f.iOfferFirst)) return { go: 'drop', row: 'O1' };
  if (!f.held || !link) return { go: 'apply', row: 'O5' };
  if (f.bothFirstOffers) {
    if (f.iOfferFirst) return { go: 'drop', row: 'O2' };
    if (f.theyOfferFirst) return { go: 'fresh', row: 'O2' };
  }
  if (!link.connectedOnce && !link.lost && !f.fresh && (link.rebuild !== 'none' || f.restartsIce)) return { go: 'drop-rebuild', row: 'O3' };
  // A connection that had connected takes an ICE restart in place even with its ICE failed: that is what the restart is
  // for, and two crossing restarts are settled by perfect negotiation (ticket 67).
  if (link.lost || f.closed || (f.iceFailed && !link.connectedOnce) || f.fresh) return { go: 'fresh', row: 'O4' };
  return { go: 'apply', row: 'O5' };
}
