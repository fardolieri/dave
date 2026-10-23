// File links (ADR 0006): a data-only RTCPeerConnection between two friends of a room, opened for one pull and closed
// after it. The friend who pulls offers; the friend who has the file answers and sends it. Signaling goes through the
// Room as `link` frames, between visitors too, and each description's DTLS fingerprints are signed by the identity key
// (ADR 0004), so the Room cannot sit in the middle. Nothing here touches the call.
import posthog from './posthog';
import { signDescription, verifyDescription } from '../core/dtls';
import { randomHex } from '../core/identity';
import { CLOSED, closeLatch, keyedChain, unlessClosed } from '../core/signalchain';
import { STUN_ONLY } from '../core/turn';
import { LINK_ICE_TTL_SECONDS } from '../core/mesh';
import { PULLS_AT_ONCE, listHash, parsePullFrame, pieceCount, type PullFrame } from '../core/attachment';
import { MAX_CANDIDATES_PER_MESSAGE, type ClientMessage, type IceServer, type LinkData, type ServerMessage } from '../core/protocol';
import type { LocalIdentity } from './identity';
import { hashOf, keptFile, listOf } from './files';

/** A link that has not opened its channel within this long is given up: the friend is unreachable from here. */
const CONNECT_TIMEOUT_MS = 20_000;
/** A friend asked for a pieced file's list answers within this long, or she does not know the ask (an app from before). */
const LIST_ANSWER_MS = 5_000;
/** A pull that receives nothing for this long is given up. */
const STALL_TIMEOUT_MS = 20_000;
/** A link the holder kept open with nothing asked of it for this long is closed. */
const IDLE_MS = 60_000;
/**
 * Links a holder keeps open at once, from all friends and from any one friend. An offer past the first is answered
 * `busy`; one past the second takes the place of that friend's quietest link.
 */
const MAX_SERVING = 8;
const MAX_SERVING_PER_FRIEND = PULLS_AT_ONCE;
/** The largest chunk sent; both browsers take this, and the link's own limit lowers it if it says less. */
const CHUNK_BYTES = 64 * 1024;
/** The sender waits while more than this is queued on the channel, until it drains to a quarter of it. */
const HIGH_WATER = 1024 * 1024;

/** Why a pull failed, as the chat says it. */
export type PullError = 'unreachable' | 'lost' | 'not there' | 'damaged' | 'busy' | 'no room';
/** Where a pieced pull puts what it checked (client/files.ts, `big.writer`): its list, and each piece at its offset. */
export type PieceSink = {
  /** The list of piece hashes, if kept from an earlier pull; else it is fetched first. */
  list: Uint8Array | null;
  keepList: (list: Uint8Array) => Promise<void>;
  /** Bytes already on disk and checked. */
  start: number;
  write: (offset: number, bytes: ArrayBuffer) => Promise<void>;
};

export class PullFailed extends Error {
  constructor(readonly reason: PullError) { super(`pull failed: ${reason}`); }
}

type Link = {
  peer: string;
  id: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  latch: ReturnType<typeof closeLatch>;
  /** Candidates that came before the remote description. */
  early: RTCIceCandidateInit[];
  remoteSet: boolean;
  /** My candidates gathered before my description went out: sent after it, or the other side has no link to put them on. */
  held: RTCIceCandidateInit[] | null;
  /** Holder side: this link serves; `busy` while a `get` is answered, one at a time. */
  serving: boolean;
  /** Its channel came up once. One that never did is reported as it closes (`file_link_failed`). */
  opened: boolean;
  /** Candidate types gathered here and received from the other side (host, srflx, prflx, relay), and whether TURN was offered. */
  local: Set<string>;
  remote: Set<string>;
  turn: boolean;
  createdAt: number;
  /** When it last moved: made, asked, or a chunk handed to the channel. A dead link stops once its buffer is full. */
  lastActive: number;
  /** Puller side: the holder answered that she is at her limit. */
  atLimit?: true;
  busy: boolean;
  idle?: ReturnType<typeof setTimeout>;
};

const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
/** The type an ICE candidate line names (`typ host`, `typ relay`, …). */
const candidateType = (line: string): string => /\btyp (\w+)/.exec(line)?.[1] ?? 'unknown';

/**
 * The file links of one room. `serves` says whether a file is one this room has seen announced: a friend can pull only
 * those, not whatever else this browser keeps from other rooms.
 */
export function createLinks(opts: { identity: LocalIdentity; send: (m: ClientMessage) => boolean; serves: (hash: string, peer: string) => Promise<boolean> }) {
  const me = opts.identity.publicKey;
  const links = new Map<string, Link>();
  /** Friends whose offer is being answered, before its link exists. */
  const starting: string[] = [];
  const keyOf = (peer: string, id: string) => `${peer}:${id}`;
  const chain = keyedChain((e) => { if (e !== CLOSED) console.error('file link signal failed', e); });

  // ICE servers for links, minted by the Room for an hour; asked again a while before they run out.
  // One ask at a time, shared by every link that starts meanwhile: the Room answers a second ask within a minute with
  // an error. An answer that comes after the wait gave up is still kept for the next link.
  let ice: { servers: IceServer[]; at: number } | null = null;
  let asking: Promise<IceServer[]> | null = null;
  let nextIce = 1;
  const iceWaiters = new Map<number, (servers: IceServer[]) => void>();
  function iceServers(): Promise<IceServer[]> {
    if (ice && Date.now() - ice.at < (LINK_ICE_TTL_SECONDS - 600) * 1000) return Promise.resolve(ice.servers);
    if (asking) return asking;
    const id = nextIce++;
    if (!opts.send({ t: 'linkice', id })) return Promise.resolve(STUN_ONLY);
    asking = new Promise<IceServer[]>((resolve) => {
      const timer = setTimeout(() => { asking = null; resolve(STUN_ONLY); }, 5000);
      iceWaiters.set(id, (servers) => {
        clearTimeout(timer);
        iceWaiters.delete(id);
        ice = { servers, at: Date.now() };
        asking = null;
        resolve(servers);
      });
    });
    return asking;
  }

  function open(peer: string, id: string, servers: IceServer[]): Link {
    const pc = new RTCPeerConnection({ iceServers: servers });
    const channel = pc.createDataChannel('file', { negotiated: true, id: 0, ordered: true });
    channel.binaryType = 'arraybuffer';
    const link: Link = {
      peer, id, pc, channel, latch: closeLatch(), early: [], remoteSet: false, held: [], serving: false, busy: false, opened: false,
      local: new Set(), remote: new Set(), turn: servers.some((s) => [s.urls].flat().some((u) => String(u).startsWith('turn'))), createdAt: Date.now(), lastActive: Date.now(),
    };
    links.set(keyOf(peer, id), link);
    channel.addEventListener('open', () => { link.opened = true; });
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      link.local.add(candidateType(e.candidate.candidate));
      if (link.held) link.held.push(e.candidate.toJSON());
      else opts.send({ t: 'link', to: peer, data: { link: id, candidates: [e.candidate.toJSON()] } });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') close(link, 'failed'); };
    channel.onclose = () => close(link, 'closed');
    return link;
  }

  /** Why a link was closed, for `file_link_failed`. */
  type CloseReason = 'failed' | 'closed' | 'refused' | 'evicted' | 'timeout' | 'idle' | 'cancelled' | 'pulled' | 'disposed' | 'error' | 'busy' | 'unsent';
  function close(link: Link, reason: CloseReason): void {
    if (links.get(keyOf(link.peer, link.id)) !== link) return;
    links.delete(keyOf(link.peer, link.id));
    // Why a link never came up, from either side: no answer, no route both sides could reach, no relay offered.
    if (!link.opened) {
      const { pc } = link;
      posthog.capture('file_link_failed', {
        side: link.serving ? 'holder' : 'puller', reason, answered: link.remoteSet, connection: pc.connectionState, ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState, signaling: pc.signalingState, local: [...link.local].sort(), remote: [...link.remote].sort(), turn: link.turn,
      });
    }
    clearTimeout(link.idle);
    link.latch.close();
    link.channel.onmessage = link.channel.onclose = null;
    try { link.channel.close(); } catch { /* closed already */ }
    link.pc.close();
  }

  /**
   * Sends my description, then the candidates held for it. False when it could not go out: no socket let in (one the
   * network cut a moment ago, ticket 57). Nothing would ever answer it, so the caller ends the link at once.
   */
  async function describe(link: Link, description: RTCSessionDescription | null): Promise<boolean> {
    if (!description) return false;
    const sig = await signDescription({ privateKey: opts.identity.keys.privateKey, from: me, to: link.peer, sdp: description.sdp });
    if (!opts.send({ t: 'link', to: link.peer, data: { link: link.id, description: description.toJSON(), ...(sig ? { sig } : {}) } })) return false;
    const held = link.held ?? [];
    link.held = null;
    for (let i = 0; i < held.length; i += MAX_CANDIDATES_PER_MESSAGE) {
      opts.send({ t: 'link', to: link.peer, data: { link: link.id, candidates: held.slice(i, i + MAX_CANDIDATES_PER_MESSAGE) } });
    }
    return true;
  }

  async function remote(link: Link, description: RTCSessionDescriptionInit): Promise<void> {
    await unlessClosed(link.latch.closed, link.pc.setRemoteDescription(description));
    link.remoteSet = true;
    for (const c of link.early.splice(0)) await unlessClosed(link.latch.closed, link.pc.addIceCandidate(c)).catch(() => undefined);
  }

  /** One `link` frame from a friend, in the order they came. */
  async function onLink(from: string, data: LinkData): Promise<void> {
    let link = links.get(keyOf(from, data.link));
    if (data.busy) {
      if (link && !link.serving) { link.atLimit = true; close(link, 'busy'); }
      return;
    }
    if (data.description !== undefined) {
      const description = data.description as RTCSessionDescriptionInit;
      const verdict = await verifyDescription({ from, to: me, sdp: description.sdp ?? '', signature: data.sig });
      if (verdict !== 'ok') {
        // Only a server in the middle, or an app that cheats, sends one.
        console.warn(`file link refused: ${verdict}`);
        posthog.capture('link_refused', { verdict });
        if (link) close(link, 'refused');
        return;
      }
      if (description.type === 'offer') {
        if (link) return;
        // A friend runs PULLS_AT_ONCE pulls at most: an ask from one who holds that many links here means one of
        // them is a pull they gave up, whether it ever came up or not (a pull that never connected; a tab killed mid-pull,
        // whose goodbye never came). It gives way. Before, such links held the friend's places for a minute, and every
        // "Try again" in it went unanswered (report of 2026-10-16).
        // Of their links, the one quiet longest goes: a pull they cancelled stalls, one still running keeps sending.
        const mine = () => [...links.values()].filter((l) => l.serving && l.peer === from).sort((a, b) => a.lastActive - b.lastActive);
        while (mine().length >= MAX_SERVING_PER_FRIEND) close(mine()[0]!, 'evicted');
        // Counted with the offers still waiting for ICE servers: offers from different friends run on chains of their own.
        const serving = [...[...links.values()].filter((l) => l.serving).map((l) => l.peer), ...starting];
        // At her limit she says so: silence would leave the friend at "Couldn't reach" for good (ticket 05).
        if (serving.length >= MAX_SERVING) {
          opts.send({ t: 'link', to: from, data: { link: data.link, busy: true } });
          return;
        }
        starting.push(from);
        let servers: IceServer[];
        try { servers = await iceServers(); } finally { starting.splice(starting.indexOf(from), 1); }
        link = open(from, data.link, servers);
        link.serving = true;
        const served = link;
        link.channel.onmessage = (e) => { void serve(served, e).catch((err: unknown) => { console.error('serving a file failed', err); close(served, 'error'); }); };
        idle(link);
        // The puller gives up after CONNECT_TIMEOUT_MS; a link not up by then is closed here too.
        setTimeout(() => { if (!served.opened) close(served, 'timeout'); }, CONNECT_TIMEOUT_MS + 2000);
        await remote(link, description);
        await unlessClosed(link.latch.closed, link.pc.setLocalDescription());
        if (!(await describe(link, link.pc.localDescription))) close(link, 'unsent');
      } else if (description.type === 'answer' && link && !link.remoteSet) {
        await remote(link, description);
      }
    }
    if (link && data.candidates) {
      for (const c of data.candidates as RTCIceCandidateInit[]) {
        if (typeof c?.candidate === 'string') { const type = candidateType(c.candidate); if (CANDIDATE_TYPES.has(type)) link.remote.add(type); }
        if (link.remoteSet) await unlessClosed(link.latch.closed, link.pc.addIceCandidate(c)).catch(() => undefined);
        else link.early.push(c);
      }
    }
  }

  /** The holder's link closes after a while with nothing asked of it. */
  function idle(link: Link): void {
    clearTimeout(link.idle);
    link.idle = setTimeout(() => close(link, 'idle'), IDLE_MS);
  }

  /**
   * Holder side: answers a `get` with the file from that offset, or with `none`; one at a time. The link does not idle
   * out while it sends, however slow the line. A file that cannot be read (the picked one changed on disk) is `none`.
   */
  async function serve(link: Link, e: MessageEvent): Promise<void> {
    const frame = parsePullFrame(e.data);
    link.lastActive = Date.now();
    if ((frame?.t !== 'get' && frame?.t !== 'list') || link.busy) return;
    const channel = link.channel;
    const say = (f: PullFrame) => { if (channel.readyState === 'open') channel.send(JSON.stringify(f)); };
    link.busy = true;
    clearTimeout(link.idle);
    try {
      // A pieced file's list of piece hashes, asked first (ticket 03): sent like its bytes, from the start.
      const list = frame.t === 'list' && (await opts.serves(frame.hash, link.peer)) ? await listOf(frame.hash) : null;
      const blob = frame.t === 'list' ? (list ? new Blob([list as BlobPart]) : null) : (await opts.serves(frame.hash, link.peer)) ? await keptFile(frame.hash) : null;
      const offset = frame.t === 'get' ? frame.offset : 0;
      if (!blob || offset > blob.size) { say({ t: 'none' }); return; }
      const chunk = Math.min(CHUNK_BYTES, link.pc.sctp?.maxMessageSize || CHUNK_BYTES);
      let first: ArrayBuffer;
      try { first = await blob.slice(offset, offset + chunk).arrayBuffer(); } catch { say({ t: 'none' }); return; }
      say({ t: 'have', size: blob.size });
      channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
      for (let at = offset; at < blob.size; at += chunk) {
        if (channel.readyState !== 'open') return;
        if (channel.bufferedAmount > HIGH_WATER) {
          // pc.close() closes the channel without a close event: the latch says so instead.
          await Promise.race([new Promise<void>((resolve) => { channel.addEventListener('bufferedamountlow', () => resolve(), { once: true }); }), link.latch.closed]);
          if (channel.readyState !== 'open') return;
        }
        const bytes = at === offset ? first : await blob.slice(at, at + chunk).arrayBuffer();
        // Closed while the chunk was read (given up, replaced, the room left): the pull ends here, as the loop does above.
        if (channel.readyState !== 'open') return;
        channel.send(bytes);
        link.lastActive = Date.now();
      }
    } finally {
      link.busy = false;
      if (links.get(keyOf(link.peer, link.id)) === link) idle(link);
    }
  }

  /**
   * Puller side: the file of this hash from this friend, checked against the hash. Rejects with PullFailed. `progress`
   * hears the bytes received so far (for a pieced file, those checked), `alive` every sign of life (the channel open, any
   * frame). Aborting `signal` closes the link, which ends the pull.
   *
   * A pieced file (`pieced`, ticket 03) comes another way: its list of piece hashes first (unless `sink.list` has it),
   * checked against `hash`, then its bytes from `sink.start`, each piece checked against the list and handed to
   * `sink.write` before the next. Nothing of it is held but the piece under way, and nothing is returned.
   */
  async function pull(
    from: string, hash: string, size: number, progress: (received: number) => void, signal: AbortSignal, alive: () => void = () => {},
    pieced?: { piece: number; sink: PieceSink },
  ): Promise<Blob | null> {
    const servers = await iceServers();
    if (signal.aborted) throw new PullFailed('lost');
    const link = open(from, randomHex(9), servers);
    signal.addEventListener('abort', () => close(link, 'cancelled'), { once: true });
    // The link closed under the pull (the friend left, the connection failed, the room went): no event says so.
    const gone = (reason: PullError) => link.latch.closed.then((): never => { throw new PullFailed(link.atLimit ? 'busy' : reason); });
    /**
     * Listens on the channel until `step` says done: `step` gets each frame and returns true when the stream is over.
     * Fails when nothing comes for STALL_TIMEOUT_MS, the channel closes, or `step` throws.
     */
    const receive = (ask: PullFrame, step: (data: unknown) => boolean | Promise<boolean>, first?: { ms: number; reason: PullError }) => Promise.race([gone('lost'), new Promise<void>((resolve, reject) => {
      let stall: ReturnType<typeof setTimeout>;
      const fresh = () => { clearTimeout(stall); stall = setTimeout(() => reject(new PullFailed('lost')), STALL_TIMEOUT_MS); };
      // Waiting for the first answer, a shorter wait can say what silence means.
      stall = setTimeout(() => reject(new PullFailed(first?.reason ?? 'lost')), first?.ms ?? STALL_TIMEOUT_MS);
      // Frames are taken in order, one at a time: a piece is written before the next is looked at.
      let steps = Promise.resolve();
      link.channel.onclose = () => { clearTimeout(stall); reject(new PullFailed('lost')); };
      link.channel.onmessage = (e: MessageEvent) => {
        fresh();
        alive();
        // A piece written counts as a sign of life too: a slow disk may still be writing what came long after the last
        // frame (review of the report of 2026-10-16, Grumpy Friend).
        steps = steps.then(async () => { if (await step(e.data)) { clearTimeout(stall); resolve(); } else fresh(); }).catch((err: unknown) => { clearTimeout(stall); reject(err); });
      };
      link.channel.send(JSON.stringify(ask));
    })]);
    /** The `have` a stream opens with, of this length; `none` or anything else fails the pull. */
    const opening = (data: unknown, length: number): void => {
      const frame = typeof data === 'string' ? parsePullFrame(data) : null;
      if (frame?.t === 'have' && frame.size === length) return;
      throw new PullFailed(frame?.t === 'none' ? 'not there' : 'damaged');
    };
    try {
      await link.pc.setLocalDescription();
      // An offer that did not go out is never answered: the pull ends now, not after its connect timeout, and is tried
      // again (client/room.ts). The ask came in the second a socket the network cut was being replaced (ticket 57).
      if (!(await describe(link, link.pc.localDescription))) { close(link, 'unsent'); throw new PullFailed('lost'); }
      await Promise.race([gone('unreachable'), new Promise<void>((resolve, reject) => {
        if (link.channel.readyState === 'open') { resolve(); return; }
        const timer = setTimeout(() => reject(new PullFailed('unreachable')), CONNECT_TIMEOUT_MS);
        link.channel.onopen = () => { clearTimeout(timer); alive(); resolve(); };
        link.channel.onclose = () => { clearTimeout(timer); reject(new PullFailed('unreachable')); };
      })]);

      if (!pieced) {
        const chunks: ArrayBuffer[] = [];
        let received = 0;
        let announced = false;
        await receive({ t: 'get', hash, offset: 0 }, (data) => {
          if (!announced) { opening(data, size); announced = true; return size === 0; }
          if (typeof data === 'string') throw new PullFailed('damaged');
          chunks.push(data as ArrayBuffer);
          received += (data as ArrayBuffer).byteLength;
          progress(received);
          return received >= size;
        });
        const blob = new Blob(chunks);
        if (blob.size !== size || (await hashOf(blob)) !== hash) throw new PullFailed('damaged');
        return blob;
      }

      const { piece, sink } = pieced;
      const count = pieceCount(size, piece);
      let list = sink.list;
      if (!list) {
        const want = count * 32;
        const got = new Uint8Array(want);
        let at = -1;
        // An app from before pieces does not know `list` and says nothing: taken for "not there" after a while, not for a
        // lost link the retry schedule would ask again and again (review of PR #72).
        await receive({ t: 'list', hash }, (data) => {
          if (at < 0) { opening(data, want); at = 0; return want === 0; }
          if (typeof data === 'string' || at + (data as ArrayBuffer).byteLength > want) throw new PullFailed('damaged');
          got.set(new Uint8Array(data as ArrayBuffer), at);
          at += (data as ArrayBuffer).byteLength;
          return at >= want;
        }, { ms: LIST_ANSWER_MS, reason: 'not there' });
        if ((await listHash(got)) !== hash) throw new PullFailed('damaged');
        list = got;
        await sink.keepList(list);
      }
      // From the first piece not yet on disk: a pull of it that broke goes on where it stopped.
      const start = Math.floor(sink.start / piece) * piece;
      progress(start);
      if (start >= size) return null;
      let index = start / piece;
      let buffer = new Uint8Array(Math.min(piece, size - start));
      let filled = 0;
      let announced = false;
      await receive({ t: 'get', hash, offset: start }, async (data) => {
        if (!announced) { opening(data, size); announced = true; return false; }
        if (typeof data === 'string') throw new PullFailed('damaged');
        let bytes = new Uint8Array(data as ArrayBuffer);
        while (bytes.length) {
          const take = Math.min(bytes.length, buffer.length - filled);
          buffer.set(bytes.subarray(0, take), filled);
          filled += take;
          bytes = bytes.subarray(take);
          if (filled < buffer.length) break;
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer as BufferSource));
          const expected = list!.subarray(index * 32, index * 32 + 32);
          if (!digest.every((b, i) => b === expected[i])) throw new PullFailed('damaged');
          await sink.write(index * piece, buffer.buffer as ArrayBuffer);
          index++;
          progress(Math.min(size, index * piece));
          if (index >= count) return true;
          buffer = new Uint8Array(Math.min(piece, size - index * piece));
          filled = 0;
        }
        return false;
      });
      return null;
    } finally {
      close(link, 'pulled');
    }
  }

  return {
    pull,
    /** `link` and `linkice` frames from the Room. */
    onMessage(m: ServerMessage): void {
      if (m.t === 'link') void chain(m.from, () => onLink(m.from, m.data));
      else if (m.t === 'linkice') iceWaiters.get(m.id)?.(m.iceServers);
    },
    close(): void { for (const l of [...links.values()]) close(l, 'disposed'); },
  };
}
