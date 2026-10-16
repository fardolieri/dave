// File links (ADR 0006): a data-only RTCPeerConnection between two friends of a room, opened for one pull and closed
// after it. The friend who pulls offers; the friend who has the file answers and sends it. Signaling goes through the
// Room as `link` frames, between visitors too, and each description's DTLS fingerprints are signed by the identity key
// (ADR 0004), so the Room cannot sit in the middle. Nothing here touches the call.
import posthog from './posthog';
import { signDescription, verifyDescription } from '../core/dtls';
import { CLOSED, closeLatch, keyedChain, unlessClosed } from '../core/signalchain';
import { STUN_ONLY } from '../core/turn';
import { LINK_ICE_TTL_SECONDS } from '../core/mesh';
import { parsePullFrame, type PullFrame } from '../core/attachment';
import { MAX_CANDIDATES_PER_MESSAGE, type ClientMessage, type IceServer, type LinkData, type ServerMessage } from '../core/protocol';
import type { LocalIdentity } from './identity';
import { hashOf, keptFile } from './files';

/** A link that has not opened its channel within this long is given up: the friend is unreachable from here. */
const CONNECT_TIMEOUT_MS = 20_000;
/** A pull that receives nothing for this long is given up. */
const STALL_TIMEOUT_MS = 20_000;
/** A link the holder kept open with nothing asked of it for this long is closed. */
const IDLE_MS = 60_000;
/** Links a holder keeps open at once, from all friends and from any one friend; an offer past either is not answered. */
const MAX_SERVING = 8;
const MAX_SERVING_PER_FRIEND = 2;
/** The largest chunk sent; both browsers take this, and the link's own limit lowers it if it says less. */
const CHUNK_BYTES = 64 * 1024;
/** The sender waits while more than this is queued on the channel, until it drains to a quarter of it. */
const HIGH_WATER = 1024 * 1024;

/** Why a pull failed, as the chat says it. */
export type PullError = 'unreachable' | 'lost' | 'not there' | 'damaged';
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
  busy: boolean;
  idle?: ReturnType<typeof setTimeout>;
};

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The file links of one room. `serves` says whether a file is one this room has seen announced: a friend can pull only
 * those, not whatever else this browser keeps from other rooms.
 */
export function createLinks(opts: { identity: LocalIdentity; send: (m: ClientMessage) => boolean; serves: (hash: string) => Promise<boolean> }) {
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
    const link: Link = { peer, id, pc, channel, latch: closeLatch(), early: [], remoteSet: false, held: [], serving: false, busy: false };
    links.set(keyOf(peer, id), link);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (link.held) link.held.push(e.candidate.toJSON());
      else opts.send({ t: 'link', to: peer, data: { link: id, candidates: [e.candidate.toJSON()] } });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') close(link); };
    channel.onclose = () => close(link);
    return link;
  }

  function close(link: Link): void {
    if (links.get(keyOf(link.peer, link.id)) !== link) return;
    links.delete(keyOf(link.peer, link.id));
    clearTimeout(link.idle);
    link.latch.close();
    link.channel.onmessage = link.channel.onclose = null;
    try { link.channel.close(); } catch { /* closed already */ }
    link.pc.close();
  }

  async function describe(link: Link, description: RTCSessionDescription | null): Promise<void> {
    if (!description) return;
    const sig = await signDescription({ privateKey: opts.identity.keys.privateKey, from: me, to: link.peer, sdp: description.sdp });
    opts.send({ t: 'link', to: link.peer, data: { link: link.id, description: description.toJSON(), ...(sig ? { sig } : {}) } });
    const held = link.held ?? [];
    link.held = null;
    for (let i = 0; i < held.length; i += MAX_CANDIDATES_PER_MESSAGE) {
      opts.send({ t: 'link', to: link.peer, data: { link: link.id, candidates: held.slice(i, i + MAX_CANDIDATES_PER_MESSAGE) } });
    }
  }

  async function remote(link: Link, description: RTCSessionDescriptionInit): Promise<void> {
    await unlessClosed(link.latch.closed, link.pc.setRemoteDescription(description));
    link.remoteSet = true;
    for (const c of link.early.splice(0)) await unlessClosed(link.latch.closed, link.pc.addIceCandidate(c)).catch(() => undefined);
  }

  /** One `link` frame from a friend, in the order they came. */
  async function onLink(from: string, data: LinkData): Promise<void> {
    let link = links.get(keyOf(from, data.link));
    if (data.description !== undefined) {
      const description = data.description as RTCSessionDescriptionInit;
      const verdict = await verifyDescription({ from, to: me, sdp: description.sdp ?? '', signature: data.sig });
      if (verdict !== 'ok') {
        // Only a server in the middle, or an app that cheats, sends one.
        console.warn(`file link refused: ${verdict}`);
        posthog.capture('link_refused', { verdict });
        if (link) close(link);
        return;
      }
      if (description.type === 'offer') {
        // Counted with the offers still waiting for ICE servers: offers from different friends run on chains of their own.
        const serving = [...[...links.values()].filter((l) => l.serving).map((l) => l.peer), ...starting];
        if (link || serving.length >= MAX_SERVING || serving.filter((p) => p === from).length >= MAX_SERVING_PER_FRIEND) return;
        starting.push(from);
        let servers: IceServer[];
        try { servers = await iceServers(); } finally { starting.splice(starting.indexOf(from), 1); }
        link = open(from, data.link, servers);
        link.serving = true;
        const served = link;
        link.channel.onmessage = (e) => { void serve(served, e).catch((err: unknown) => { console.error('serving a file failed', err); close(served); }); };
        idle(link);
        await remote(link, description);
        await unlessClosed(link.latch.closed, link.pc.setLocalDescription());
        await describe(link, link.pc.localDescription);
      } else if (description.type === 'answer' && link && !link.remoteSet) {
        await remote(link, description);
      }
    }
    if (link && data.candidates) {
      for (const c of data.candidates as RTCIceCandidateInit[]) {
        if (link.remoteSet) await unlessClosed(link.latch.closed, link.pc.addIceCandidate(c)).catch(() => undefined);
        else link.early.push(c);
      }
    }
  }

  /** The holder's link closes after a while with nothing asked of it. */
  function idle(link: Link): void {
    clearTimeout(link.idle);
    link.idle = setTimeout(() => close(link), IDLE_MS);
  }

  /**
   * Holder side: answers a `get` with the file from that offset, or with `none`; one at a time. The link does not idle
   * out while it sends, however slow the line. A file that cannot be read (the picked one changed on disk) is `none`.
   */
  async function serve(link: Link, e: MessageEvent): Promise<void> {
    const frame = parsePullFrame(e.data);
    if (frame?.t !== 'get' || link.busy) return;
    const channel = link.channel;
    const say = (f: PullFrame) => { if (channel.readyState === 'open') channel.send(JSON.stringify(f)); };
    link.busy = true;
    clearTimeout(link.idle);
    try {
      const blob = (await opts.serves(frame.hash)) ? await keptFile(frame.hash) : null;
      if (!blob || frame.offset > blob.size) { say({ t: 'none' }); return; }
      const chunk = Math.min(CHUNK_BYTES, link.pc.sctp?.maxMessageSize || CHUNK_BYTES);
      let first: ArrayBuffer;
      try { first = await blob.slice(frame.offset, frame.offset + chunk).arrayBuffer(); } catch { say({ t: 'none' }); return; }
      say({ t: 'have', size: blob.size });
      channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
      for (let at = frame.offset; at < blob.size; at += chunk) {
        if (channel.readyState !== 'open') return;
        if (channel.bufferedAmount > HIGH_WATER) {
          // pc.close() closes the channel without a close event: the latch says so instead.
          await Promise.race([new Promise<void>((resolve) => { channel.addEventListener('bufferedamountlow', () => resolve(), { once: true }); }), link.latch.closed]);
          if (channel.readyState !== 'open') return;
        }
        channel.send(at === frame.offset ? first : await blob.slice(at, at + chunk).arrayBuffer());
      }
    } finally {
      link.busy = false;
      if (links.get(keyOf(link.peer, link.id)) === link) idle(link);
    }
  }

  /**
   * Puller side: the file of this hash from this friend, checked against the hash. Rejects with PullFailed. `progress`
   * hears the bytes received so far. Aborting `signal` closes the link, which ends the pull.
   */
  async function pull(from: string, hash: string, size: number, progress: (received: number) => void, signal: AbortSignal): Promise<Blob> {
    const servers = await iceServers();
    if (signal.aborted) throw new PullFailed('lost');
    const link = open(from, randomId(), servers);
    signal.addEventListener('abort', () => close(link), { once: true });
    // The link closed under the pull (the friend left, the connection failed, the room went): no event says so.
    const gone = (reason: PullError) => link.latch.closed.then((): never => { throw new PullFailed(reason); });
    try {
      await link.pc.setLocalDescription();
      await describe(link, link.pc.localDescription);
      await Promise.race([gone('unreachable'), new Promise<void>((resolve, reject) => {
        if (link.channel.readyState === 'open') { resolve(); return; }
        const timer = setTimeout(() => reject(new PullFailed('unreachable')), CONNECT_TIMEOUT_MS);
        link.channel.onopen = () => { clearTimeout(timer); resolve(); };
        link.channel.onclose = () => { clearTimeout(timer); reject(new PullFailed('unreachable')); };
      })]);
      const chunks: ArrayBuffer[] = [];
      let received = 0;
      await Promise.race([gone('lost'), new Promise<void>((resolve, reject) => {
        let stall = setTimeout(() => reject(new PullFailed('lost')), STALL_TIMEOUT_MS);
        const alive = () => { clearTimeout(stall); stall = setTimeout(() => reject(new PullFailed('lost')), STALL_TIMEOUT_MS); };
        let announced = false;
        link.channel.onclose = () => { clearTimeout(stall); reject(new PullFailed('lost')); };
        link.channel.onmessage = (e: MessageEvent) => {
          alive();
          if (typeof e.data === 'string') {
            const frame = parsePullFrame(e.data);
            if (frame?.t === 'have' && frame.size === size) { announced = true; if (size === 0) { clearTimeout(stall); resolve(); } return; }
            clearTimeout(stall);
            reject(new PullFailed(frame?.t === 'none' ? 'not there' : 'damaged'));
            return;
          }
          if (!announced) return;
          chunks.push(e.data as ArrayBuffer);
          received += (e.data as ArrayBuffer).byteLength;
          progress(received);
          if (received >= size) { clearTimeout(stall); resolve(); }
        };
        link.channel.send(JSON.stringify({ t: 'get', hash, offset: 0 } satisfies PullFrame));
      })]);
      const blob = new Blob(chunks);
      if (blob.size !== size || (await hashOf(blob)) !== hash) throw new PullFailed('damaged');
      return blob;
    } finally {
      close(link);
    }
  }

  return {
    pull,
    /** `link` and `linkice` frames from the Room. */
    onMessage(m: ServerMessage): void {
      if (m.t === 'link') void chain(m.from, () => onLink(m.from, m.data));
      else if (m.t === 'linkice') iceWaiters.get(m.id)?.(m.iceServers);
    },
    close(): void { for (const l of [...links.values()]) close(l); },
  };
}
