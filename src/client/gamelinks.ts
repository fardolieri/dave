// Game links (ADR 0014): a data-only RTCPeerConnection between two players of the room's game, open while both play it.
// Everything that moves in a game goes over them, many times a second, and never through the server. Signaling goes
// through the Room as `link` frames, as a file link's does (client/links.ts), named after the game (core/game.ts,
// `gameLinkId`) so the two never meet; each description's DTLS fingerprints are signed by the identity key (ADR 0004).
// Of two players, the one with the smaller key offers; the other answers an offer only for the game it plays.
import { signDescription, verifyDescription } from '../core/dtls';
import { gameLinkId, gameOfLink } from '../core/game';
import { CLOSED, closeLatch, keyedChain, unlessClosed } from '../core/signalchain';
import { MAX_CANDIDATES_PER_MESSAGE, type ClientMessage, type IceServer, type LinkData } from '../core/protocol';
import type { LocalIdentity } from './identity';

/** A link that has not opened within this long is closed, and the offering side tries again. */
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * How long the offering side waits before it tries a link again that failed or closed: twice as long each time it
 * fails again, up to a minute, so a pair that cannot reach each other does not signal through the Room all game.
 */
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

type Link = {
  peer: string;
  game: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  latch: ReturnType<typeof closeLatch>;
  early: RTCIceCandidateInit[];
  remoteSet: boolean;
  held: RTCIceCandidateInit[] | null;
  timeout: ReturnType<typeof setTimeout>;
};

export function createGameLinks(opts: { identity: LocalIdentity; send: (m: ClientMessage) => boolean; iceServers: () => Promise<IceServer[]> }) {
  const me = opts.identity.publicKey;
  const links = new Map<string, Link>();
  /** The game I play and who else plays it; none while I play none. */
  let want: { game: string; peers: Set<string> } | null = null;
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** How long the next try to each player waits; back to RETRY_MS once their link opens. */
  const backoff = new Map<string, number>();
  const listeners = new Set<(from: string, data: unknown) => void>();
  const changes = new Set<() => void>();
  const chain = keyedChain((e) => { if (e !== CLOSED) console.error('game link signal failed', e); });
  const changed = () => { for (const f of changes) f(); };
  /**
   * How many offers each player has sent me, counted as they come in, before their turn in the chain: an offer with a
   * newer one behind it is not answered. The newer one took its place on their side (`open` closes the link it replaces),
   * and an answer to it, late, would be taken there for the newer one's.
   */
  const offered = new Map<string, number>();

  const wanted = (peer: string, game: string): boolean => want !== null && want.game === game && want.peers.has(peer);

  function open(peer: string, game: string, servers: IceServer[]): Link {
    const pc = new RTCPeerConnection({ iceServers: servers });
    // Unordered and never sent again: a ball's place a moment old is worth nothing once a newer one is on its way.
    const channel = pc.createDataChannel('game', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const link: Link = { peer, game, pc, channel, latch: closeLatch(), early: [], remoteSet: false, held: [], timeout: setTimeout(() => { if (channel.readyState !== 'open') close(link); }, CONNECT_TIMEOUT_MS) };
    const was = links.get(peer);
    if (was) close(was);
    links.set(peer, link);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (link.held) link.held.push(e.candidate.toJSON());
      else opts.send({ t: 'link', to: peer, data: { link: gameLinkId({ id: game }), candidates: [e.candidate.toJSON()] } });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') close(link); };
    channel.onopen = () => { backoff.delete(peer); changed(); };
    channel.onclose = () => close(link);
    channel.onmessage = (e) => { for (const f of listeners) f(peer, e.data); };
    return link;
  }

  function close(link: Link): void {
    if (links.get(link.peer) !== link) return;
    links.delete(link.peer);
    clearTimeout(link.timeout);
    link.latch.close();
    link.channel.onmessage = link.channel.onclose = link.channel.onopen = null;
    try { link.channel.close(); } catch { /* closed already */ }
    link.pc.close();
    changed();
    // Still both in the game: the offering side tries again in a moment.
    if (me < link.peer && wanted(link.peer, link.game)) retry(link.peer);
  }

  function retry(peer: string): void {
    if (retries.has(peer)) return;
    const wait = backoff.get(peer) ?? RETRY_MS;
    backoff.set(peer, Math.min(wait * 2, MAX_RETRY_MS));
    retries.set(peer, setTimeout(() => { retries.delete(peer); offer(peer); }, wait));
  }

  async function describe(link: Link, description: RTCSessionDescription | null): Promise<boolean> {
    if (!description) return false;
    const sig = await signDescription({ privateKey: opts.identity.keys.privateKey, from: me, to: link.peer, sdp: description.sdp });
    const name = gameLinkId({ id: link.game });
    if (!opts.send({ t: 'link', to: link.peer, data: { link: name, description: description.toJSON(), ...(sig ? { sig } : {}) } })) return false;
    const held = link.held ?? [];
    link.held = null;
    for (let i = 0; i < held.length; i += MAX_CANDIDATES_PER_MESSAGE) opts.send({ t: 'link', to: link.peer, data: { link: name, candidates: held.slice(i, i + MAX_CANDIDATES_PER_MESSAGE) } });
    return true;
  }

  async function remote(link: Link, description: RTCSessionDescriptionInit): Promise<void> {
    await unlessClosed(link.latch.closed, link.pc.setRemoteDescription(description));
    link.remoteSet = true;
    for (const c of link.early.splice(0)) await unlessClosed(link.latch.closed, link.pc.addIceCandidate(c)).catch(() => undefined);
  }

  /** Offers a link to a player whose key is greater than mine, unless one is up or under way. */
  function offer(peer: string): void {
    const game = want?.game;
    if (!game || !wanted(peer, game) || links.get(peer)?.game === game) return;
    void chain(peer, async () => {
      const servers = await opts.iceServers();
      if (!wanted(peer, game) || links.get(peer)?.game === game) return;
      const link = open(peer, game, servers);
      await unlessClosed(link.latch.closed, link.pc.setLocalDescription());
      if (!(await describe(link, link.pc.localDescription))) { close(link); retry(peer); }
    });
  }

  async function onLink(from: string, data: LinkData, game: string, offer: number): Promise<void> {
    let link = links.get(from);
    if (data.description !== undefined) {
      const description = data.description as RTCSessionDescriptionInit;
      const verdict = await verifyDescription({ from, to: me, sdp: description.sdp ?? '', signature: data.sig });
      if (verdict !== 'ok') { console.warn(`game link refused: ${verdict}`); if (link?.game === game) close(link); return; }
      if (description.type === 'offer') {
        // Only from the side that offers, and for the game I play, though presence may not list the friend in it yet (they
        // just came in). One again (the friend reloaded) takes the old one's place.
        if (from > me || want?.game !== game) return;
        // A page that did not run for a while (busy drawing) finds their next offer behind this one: that one is answered.
        if (offered.get(from) !== offer) return;
        const servers = await opts.iceServers();
        if (want?.game !== game) return; // left it meanwhile
        link = open(from, game, servers);
        await remote(link, description);
        await unlessClosed(link.latch.closed, link.pc.setLocalDescription());
        if (!(await describe(link, link.pc.localDescription))) close(link);
      } else if (description.type === 'answer' && link && link.game === game && !link.remoteSet) {
        await remote(link, description);
      }
    }
    if (link && link.game === game && data.candidates) {
      for (const c of data.candidates as RTCIceCandidateInit[]) {
        if (link.remoteSet) await unlessClosed(link.latch.closed, link.pc.addIceCandidate(c)).catch(() => undefined);
        else link.early.push(c);
      }
    }
  }

  return {
    /** Whether a `link` frame's name is a game link's: those go here, not to the file links. */
    owns: (name: string): boolean => gameOfLink(name) !== null,
    /** A `link` frame of a game link, from the Room. */
    onLink(from: string, data: LinkData): void {
      const game = gameOfLink(data.link);
      if (!game) return;
      const isOffer = (data.description as { type?: unknown } | undefined)?.type === 'offer';
      const offer = isOffer ? (offered.get(from) ?? 0) + 1 : 0;
      if (isOffer) offered.set(from, offer);
      void chain(from, () => onLink(from, data, game, offer));
    },
    /**
     * The game I play (its id) and who else in the call plays it; null for none. Links to players who left it close,
     * links to new ones open.
     */
    play(game: string | null, peers: readonly string[]): void {
      want = game === null ? null : { game, peers: new Set(peers.filter((p) => p !== me)) };
      // A player who leaves the game closes their side; here only the links of another game close.
      for (const link of [...links.values()]) if (link.game !== want?.game) close(link);
      for (const [peer, t] of retries) if (!want?.peers.has(peer)) { clearTimeout(t); retries.delete(peer); }
      for (const peer of backoff.keys()) if (!want?.peers.has(peer)) backoff.delete(peer);
      if (want) for (const peer of want.peers) if (me < peer) offer(peer);
    },
    /** Sends to every player whose link is open. */
    broadcast(text: string): void {
      for (const link of links.values()) if (link.channel.readyState === 'open') { try { link.channel.send(text); } catch { /* closing */ } }
    },
    /** Sends to one player, if their link is open. */
    sendTo(peer: string, text: string): void {
      const link = links.get(peer);
      if (link?.channel.readyState === 'open') { try { link.channel.send(text); } catch { /* closing */ } }
    },
    /** The players whose link is open. */
    connected: (): string[] => [...links.values()].filter((l) => l.channel.readyState === 'open').map((l) => l.peer),
    /** Hears every message from every player; returns how to stop. */
    listen(f: (from: string, data: unknown) => void): () => void { listeners.add(f); return () => listeners.delete(f); },
    /** Hears every link that opens or closes; returns how to stop. */
    onChange(f: () => void): () => void { changes.add(f); return () => changes.delete(f); },
    close(): void {
      want = null;
      for (const t of retries.values()) clearTimeout(t);
      retries.clear();
      backoff.clear();
      for (const link of [...links.values()]) close(link);
    },
  };
}
export type GameLinks = ReturnType<typeof createGameLinks>;
