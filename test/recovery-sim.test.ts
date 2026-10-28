import { describe, expect, it } from 'vitest';
import { freshCounts, newLink, offerPath, step, stillRebuild, type Action, type ConnectionState, type Counts, type Event, type IceState, type Link, type Timer } from '../src/core/recovery';

// Two friends over a fake network, each with the recovery of core/recovery.ts (ADR 0008), for the sequences where the
// two sides disagree. It models what recovery depends on, not WebRTC: a connection has a certificate and an ICE ufrag,
// signals carry them, and the network decides per pairing whether ICE and the handshake get through. Ticket 63's
// Firefox bug is modelled too: a connection restarted before it was ever up comes up one-way. Alice joined first, so
// Bob offers first; Alice is the polite side.

type Fault = 'ok' | 'ice-fail' | 'one-sided' | 'handshake-fail';
type Desc = { cert: number; ufrag: number; connId: number };
type Signal = { type: 'offer' | 'answer'; from: Side; connId: number; forConn?: number; cert: number; ufrag: number };
type Conn = {
  id: number; cert: number; ufrag: number; link: Link; ice: IceState; connection: ConnectionState;
  remote?: Desc; localOffer: boolean; closed: boolean; timers: Partial<Record<Timer, number>>;
  restartedBeforeUp: boolean; oneWay: boolean; foreignAnswer: boolean; restarts: number;
};
type Side = { name: string; offersFirst: boolean; polite: boolean; old: boolean; conn?: Conn; counts: Counts; other?: Side; sees: { lost: boolean }; frozen: boolean };

class World {
  now = 0;
  private queue: Array<{ t: number; id: number; fn: () => void }> = [];
  private ids = 0;
  private cancelled = new Set<number>();
  private nextId = 1;
  private pairings = 0;
  private settled = '';
  readonly a: Side;
  readonly b: Side;
  log: string[] = [];

  constructor(private faults: Fault[], opts: { aliceOld?: boolean; bobOld?: boolean } = {}) {
    this.a = { name: 'Alice', offersFirst: false, polite: true, old: !!opts.aliceOld, counts: freshCounts(), sees: { lost: false }, frozen: false };
    this.b = { name: 'Bob', offersFirst: true, polite: false, old: !!opts.bobOld, counts: freshCounts(), sees: { lost: false }, frozen: false };
    this.a.other = this.b;
    this.b.other = this.a;
  }

  at(ms: number, fn: () => void): number { const id = ++this.ids; this.queue.push({ t: this.now + ms, id, fn }); return id; }
  cancel(id: number | undefined): void { if (id !== undefined) this.cancelled.add(id); }
  run(untilMs: number): void {
    if (untilMs < this.now) throw new Error(`time runs forward: ${untilMs} < ${this.now}`);
    for (;;) {
      this.queue.sort((x, y) => x.t - y.t || x.id - y.id);
      const next = this.queue[0];
      if (!next || next.t > untilMs) { this.now = untilMs; return; }
      this.queue.shift();
      this.now = next.t;
      if (!this.cancelled.has(next.id)) next.fn();
    }
  }

  // ---- the app, as call.ts carries out the machine's actions
  start(): void { this.create(this.b, true); }
  private create(side: Side, initiator: boolean): Conn {
    const conn: Conn = {
      id: this.nextId++, cert: this.nextId++, ufrag: this.nextId++, link: newLink(initiator, side.counts), ice: 'new', connection: 'new',
      localOffer: false, closed: false, timers: {}, restartedBeforeUp: false, oneWay: false, foreignAnswer: false, restarts: 0,
    };
    // An app from before ticket 63 restarts a connection that never connected instead of rebuilding it, and applies
    // every offer: as if every connection had connected once.
    if (side.old) conn.link.connectedOnce = true;
    side.conn = conn;
    this.recover(side, conn, { on: 'built' });
    if (initiator) this.offer(side, conn, undefined);
    return conn;
  }
  private close(side: Side, conn: Conn): void {
    for (const t of Object.values(conn.timers)) this.cancel(t);
    conn.closed = true;
    if (side.conn === conn) side.conn = undefined;
    this.settle();
  }
  private recover(side: Side, conn: Conn, event: Event): void {
    if (side.conn !== conn && event.on !== 'rebuilt') return;
    for (const a of step(conn.link, side.counts, event, { iOfferFirst: side.offersFirst })) this.act(side, conn, a);
  }
  private act(side: Side, conn: Conn, a: Action): void {
    switch (a.do) {
      case 'arm':
        this.cancel(conn.timers[a.timer]);
        conn.timers[a.timer] = this.at(a.ms, () => this.fire(side, conn, a.timer));
        break;
      case 'cancel': this.cancel(conn.timers[a.timer]); conn.timers[a.timer] = undefined; break;
      case 'restart':
        if (conn.closed) break;
        conn.restarts++;
        if (conn.connection !== 'connected' && !conn.oneWay) conn.restartedBeforeUp = true;
        conn.ufrag = this.nextId++;
        this.offer(side, conn, conn.remote?.connId);
        break;
      case 'rebuild': {
        const done = side.conn === conn && (a.why === 'stuck' ? stillRebuild(conn.link, 'stuck', conn.connection) : stillRebuild(conn.link, 'failed', conn.connection));
        if (done) {
          this.close(side, conn);
          side.counts.stalled = a.stalled;
          this.create(side, true);
        }
        if (a.why === 'failed') this.recover(side, conn, { on: 'rebuilt', why: 'failed', done });
        break;
      }
      case 'close': this.close(side, conn); break;
      case 'resend': if (conn.localOffer) this.offer(side, conn, conn.remote?.connId); break;
      default: break;
    }
  }
  /** A timer of a frozen tab fires once it thaws. */
  private fire(side: Side, conn: Conn, timer: Timer): void {
    if (side.frozen) { conn.timers[timer] = this.at(500, () => this.fire(side, conn, timer)); return; }
    conn.timers[timer] = undefined;
    this.recover(side, conn, { on: 'timer', timer, ice: conn.ice, connection: conn.connection });
  }
  private offer(side: Side, conn: Conn, forConn: number | undefined): void {
    conn.localOffer = true;
    this.send({ type: 'offer', from: side, connId: conn.id, forConn, cert: conn.cert, ufrag: conn.ufrag });
  }
  private send(s: Signal): void {
    const to = s.from.other!;
    // A friend whose socket is gone gets nothing from the Room, and sends nothing through it.
    if (to.sees.lost || s.from.sees.lost) return;
    this.at(50, () => this.receive(to, s));
  }
  private receive(side: Side, s: Signal): void {
    let conn = side.conn;
    if (s.type === 'answer') {
      if (!conn || !conn.localOffer || s.forConn !== conn.id) return; // stale answer
      if (conn.remote && conn.remote.cert !== s.cert) conn.foreignAnswer = true;
      conn.remote = { cert: s.cert, ufrag: s.ufrag, connId: s.connId };
      conn.localOffer = false;
      this.settle();
      return;
    }
    const facts = {
      held: !!conn,
      namesGone: s.forConn !== undefined && (!conn || conn.id !== s.forConn),
      bothFirstOffers: !!conn && s.forConn === undefined && !conn.remote && conn.localOffer,
      iOfferFirst: side.offersFirst,
      theyOfferFirst: !side.offersFirst,
      fresh: !!conn?.remote && conn.remote.cert !== s.cert,
      restartsIce: !!conn?.remote && conn.remote.ufrag !== s.ufrag,
      deadIce: !!conn && (conn.ice === 'failed' || conn.closed),
    };
    const { go } = offerPath(conn?.link, side.old ? { ...facts, restartsIce: false } : facts);
    if (go === 'drop') return;
    if (go === 'drop-rebuild' && conn) { this.recover(side, conn, { on: 'rebuild-now' }); return; }
    if (go === 'fresh' && conn) { this.close(side, conn); conn = undefined; }
    if (!conn) conn = this.create(side, false);
    // Perfect negotiation: in a collision the impolite side ignores the offer, the polite side rolls back.
    if (conn.localOffer) { if (!side.polite) return; conn.localOffer = false; }
    if (conn.remote && conn.remote.ufrag !== s.ufrag) {
      if (conn.connection !== 'connected' && !conn.oneWay) conn.restartedBeforeUp = true; // a restart applied in place
      conn.ufrag = this.nextId++;
    }
    conn.remote = { cert: s.cert, ufrag: s.ufrag, connId: s.connId };
    this.send({ type: 'answer', from: side, connId: conn.id, forConn: s.connId, cert: conn.cert, ufrag: conn.ufrag });
    this.settle();
  }

  // ---- the network
  private setState(side: Side, conn: Conn, ice: IceState, connection: ConnectionState): void {
    if (conn.closed || side.conn !== conn) return;
    const iceChanged = conn.ice !== ice;
    const connChanged = conn.connection !== connection;
    conn.ice = ice;
    conn.connection = connection;
    if (connChanged && connection === 'connected' && conn.restartedBeforeUp) conn.oneWay = true;
    if (iceChanged) this.recover(side, conn, { on: 'ice', ice, connection });
    if (connChanged && side.conn === conn) this.recover(side, conn, { on: 'connection', ice: conn.ice, connection: conn.connection });
  }
  private matched(x: Conn | undefined, y: Conn | undefined): boolean {
    return !!x && !!y && !x.localOffer && !y.localOffer && x.remote?.cert === y.cert && x.remote.ufrag === y.ufrag && y.remote?.cert === x.cert && y.remote.ufrag === x.ufrag;
  }
  /** After any change of descriptions: the network's answer for the pair of connections there is now. */
  private settle(): void {
    this.at(300, () => {
      const { a, b } = this;
      const [ca, cb] = [a.conn, b.conn];
      if (this.matched(ca, cb)) {
        const key = `${ca!.id}:${ca!.ufrag}|${cb!.id}:${cb!.ufrag}`;
        if (key === this.settled) return;
        this.settled = key;
        const fault = this.faults[this.pairings++] ?? 'ok';
        this.log.push(`${this.now} pairing ${key}: ${fault}`);
        if (fault === 'ok') this.at(200, () => { this.setState(a, ca!, 'connected', 'connected'); this.setState(b, cb!, 'connected', 'connected'); });
        if (fault === 'handshake-fail') this.at(200, () => { this.setState(a, ca!, 'connected', 'failed'); this.setState(b, cb!, 'connected', 'failed'); });
        if (fault === 'ice-fail') this.at(5_000, () => { this.setState(a, ca!, 'failed', 'failed'); this.setState(b, cb!, 'failed', 'failed'); });
        if (fault === 'one-sided') {
          // Bob's last handshake flight is lost: Alice is up, Bob never gets there; then the path goes.
          this.at(200, () => { this.setState(a, ca!, 'connected', 'connected'); this.setState(b, cb!, 'connected', 'connecting'); });
          this.at(3_000, () => { this.setState(a, ca!, 'disconnected', 'disconnected'); this.setState(b, cb!, 'disconnected', 'connecting'); });
        }
        return;
      }
      // A connection whose other end is gone, or holds another certificate, carries nothing: down if it had been up,
      // failed otherwise.
      for (const [side, mine, theirs] of [[a, ca, cb], [b, cb, ca]] as const) {
        if (!mine?.remote || mine.localOffer) continue;
        if (theirs && theirs.cert === mine.remote.cert && !theirs.localOffer) continue;
        if (mine.connection === 'connected') this.at(1_000, () => { if (side.conn === mine && mine.connection === 'connected') this.setState(side, mine, 'disconnected', 'disconnected'); });
        else this.at(5_000, () => { if (side.conn === mine && mine.connection !== 'connected') this.setState(side, mine, 'failed', 'failed'); });
      }
    });
  }

  /** The friend's socket gone from the other's presence, their tab frozen meanwhile (a phone in a pocket); and back. */
  lose(side: Side): void { side.frozen = true; const viewer = side.other!; viewer.sees.lost = true; if (viewer.conn) this.recover(viewer, viewer.conn, { on: 'lost', ice: viewer.conn.ice }); }
  back(side: Side): void { const viewer = side.other!; viewer.sees.lost = false; if (viewer.conn) this.recover(viewer, viewer.conn, { on: 'back' }); side.frozen = false; }

  /** The path goes under a live call: ICE fails at both ends. */
  breakPath(): void { for (const side of [this.a, this.b]) if (side.conn) this.setState(side, side.conn, 'failed', 'failed'); }

  /** Both friends in a call that carries voice both ways, on one matched pair of connections. */
  healthy(): boolean {
    const [ca, cb] = [this.a.conn, this.b.conn];
    return this.matched(ca, cb) && ca!.connection === 'connected' && cb!.connection === 'connected' && !ca!.oneWay && !cb!.oneWay;
  }
  /** Every connection there was, for the invariants. */
  conns(): Conn[] { return [this.a.conn, this.b.conn].filter((c): c is Conn => !!c); }
}

/** Runs until the call is healthy or `limitMs` passes; the time it took, or the log. */
function recoveryTime(w: World, limitMs: number): number {
  for (let t = w.now + 1_000; t <= limitMs; t += 1_000) { w.run(t); if (w.healthy()) return t; }
  throw new Error(`no healthy call within ${limitMs} ms:\n${w.log.join('\n')}\nAlice ${JSON.stringify(w.a.conn?.link)} Bob ${JSON.stringify(w.b.conn?.link)}`);
}

describe('recovery between two friends (simulation)', () => {
  it('a clean start connects at once', () => {
    const w = new World([]);
    w.start();
    expect(recoveryTime(w, 5_000)).toBeLessThanOrEqual(2_000);
  });

  it('a first attempt whose ICE fails on both sides is rebuilt, never restarted, and connects both ways (ticket 63)', () => {
    const w = new World(['ice-fail']);
    w.start();
    expect(recoveryTime(w, 60_000)).toBeLessThan(30_000);
    for (const c of w.conns()) { expect(c.oneWay).toBe(false); expect(c.restarts).toBe(0); }
  });

  it('failures over and over back off, and the call connects once the network lets it', () => {
    const w = new World(['ice-fail', 'ice-fail', 'ice-fail']);
    w.start();
    expect(recoveryTime(w, 120_000)).toBeLessThan(90_000);
    expect(w.conns().every((c) => !c.oneWay)).toBe(true);
  });

  it('a handshake through on one side only, then the path going, ends in a call both ways, with no foreign certificate', () => {
    const w = new World(['one-sided']);
    w.start();
    recoveryTime(w, 60_000);
    for (const c of w.conns()) { expect(c.oneWay).toBe(false); expect(c.foreignAnswer).toBe(false); }
  });

  it('a friend still on the app from before ticket 63, restarting a connection that never connected, does not leave me one-way', () => {
    const w = new World(['ice-fail'], { bobOld: true });
    w.start();
    recoveryTime(w, 60_000);
    expect(w.a.conn!.oneWay).toBe(false);
  });

  it('a friend lost while my rebuild waits, back within the grace, gets a call both ways (R12, R9 declined, R14)', () => {
    // The handshake fails while ICE is up, so the connection outlives their socket (R12 closes one whose ICE failed).
    const w = new World(['handshake-fail']);
    w.start();
    w.run(600); // failed at 550: Alice's rebuild waits 7 s, Bob's 2 s
    w.lose(w.b);
    expect(w.a.conn!.link).toMatchObject({ lost: true, rebuild: 'waiting' });
    w.run(20_000); // Alice's rebuild came due while Bob was away, and was declined
    expect(w.a.conn!.link).toMatchObject({ lost: true, rebuild: 'none', badge: 'unreachable', connectedOnce: false });
    w.back(w.b);
    expect(w.a.conn!.link.rebuild).toBe('waiting'); // R14: rebuilt now they are back
    recoveryTime(w, 60_000);
    expect(w.conns().every((c) => !c.oneWay)).toBe(true);
  });

  it('a call that was up and loses its path at both ends comes back, today by way of new connections', () => {
    const w = new World(['ok', 'ok']);
    w.start();
    recoveryTime(w, 5_000);
    const [a, b] = [w.a.conn!, w.b.conn!];
    w.breakPath(); // Wi-Fi changed under one of them: ICE failed at both ends
    const broke = w.now;
    const took = recoveryTime(w, broke + 60_000) - broke;
    // Both restarts are answered from new connections, which then fail against the closed old ones; rebuilds bring the
    // call back, 10 s after the break in this model.
    expect(took).toBeLessThan(15_000);
    expect([w.a.conn, w.b.conn]).not.toEqual([a, b]);
    expect(w.conns().every((c) => !c.oneWay)).toBe(true);
  });

  // Ticket 67: both ends restart, and each, its ICE failed, answers the other's restart offer from a new connection (O4).
  // Neither restart is used: the new connections fail against the closed old ones, and the call comes back by rebuilds.
  it.fails('a call that was up and loses its path at both ends comes back by ICE restarts, on the same connections (ticket 67)', () => {
    const w = new World(['ok', 'ok']);
    w.start();
    recoveryTime(w, 5_000);
    const [a, b] = [w.a.conn!, w.b.conn!];
    w.breakPath();
    recoveryTime(w, w.now + 30_000);
    expect([w.a.conn, w.b.conn]).toEqual([a, b]);
    expect(a.foreignAnswer || b.foreignAnswer).toBe(false);
  });
});
