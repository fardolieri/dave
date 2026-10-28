import { describe, expect, it } from 'vitest';
import { ICE_DISCONNECTED_GRACE_MS, PEER_GRACE_MS } from '../src/core/mesh';
import { freshCounts, newLink, offerPath, step, stillRebuild, type Action, type Counts, type Event, type Link, type OfferFacts } from '../src/core/recovery';

// The table "Recovery rules" of spec §8.2, row by row (ADR 0008). Each test names its row.

const first = { iOfferFirst: true };
const second = { iOfferFirst: false };
/** A connection, as it stands after `events`, with the actions of the last one. */
function run(events: Event[], opts: { initiator?: boolean; counts?: Counts; ctx?: { iOfferFirst: boolean } } = {}) {
  const counts = opts.counts ?? freshCounts();
  const link = newLink(opts.initiator ?? true, counts);
  let actions: Action[] = [];
  for (const e of events) actions = step(link, counts, e, opts.ctx ?? first);
  return { link, counts, actions };
}
const up: Event[] = [{ on: 'ice', ice: 'connected', connection: 'connecting' }, { on: 'connection', ice: 'connected', connection: 'connected' }];
const iceFailed: Event = { on: 'ice', ice: 'failed', connection: 'failed' };
const arms = (actions: Action[]) => actions.filter((a) => a.do === 'arm');

describe('recovery rules', () => {
  it('R1: a built connection arms its watchdog by the stalled attempts it was built with, the answerer later', () => {
    expect(run([{ on: 'built' }]).actions).toEqual([{ do: 'arm', timer: 'watchdog', ms: 15_000 }]);
    expect(run([{ on: 'built' }], { initiator: false, counts: { stalled: 1, rebuilds: 0 } }).actions).toEqual([{ do: 'arm', timer: 'watchdog', ms: 35_000 }]);
  });

  it('R2: ICE up resets the restarts and cancels a waiting restart, but not a waiting rebuild', () => {
    const { link, actions } = run([...up, { on: 'ice', ice: 'disconnected', connection: 'connected' }, { on: 'timer', timer: 'disconnect', ice: 'disconnected', connection: 'connected' }, iceFailed, { on: 'ice', ice: 'connected', connection: 'connected' }]);
    expect(link.restarts).toBe(0);
    expect(actions).toContainEqual({ do: 'cancel', timer: 'restart' });
    const never = run([iceFailed, { on: 'ice', ice: 'connected', connection: 'connecting' }]);
    expect(never.link.rebuild).toBe('waiting');
    expect(never.actions).not.toContainEqual({ do: 'cancel', timer: 'rebuild' });
  });

  it('R2 then R5: ICE up over a handshake that failed is a failure', () => {
    const { link, actions } = run([{ on: 'ice', ice: 'connected', connection: 'failed' }]);
    expect(link.badge).toBe('unreachable');
    expect(arms(actions)).toEqual([{ do: 'arm', timer: 'rebuild', ms: 2_000 }]);
  });

  it('R3: ICE disconnected shows reconnecting and waits the grace', () => {
    expect(run([...up, { on: 'ice', ice: 'disconnected', connection: 'connected' }]).actions).toEqual([
      { do: 'cancel', timer: 'disconnect' }, { do: 'badge', badge: 'reconnecting' }, { do: 'arm', timer: 'disconnect', ms: ICE_DISCONNECTED_GRACE_MS },
    ]);
  });

  it('R4: up cancels every recovery timer, clears the friend\'s counts and shows up', () => {
    const counts = { stalled: 2, rebuilds: 3 };
    const { link, actions } = run([iceFailed, ...up], { counts });
    expect(link).toMatchObject({ connectedOnce: true, rebuild: 'none', badge: 'up' });
    expect(counts).toEqual({ stalled: 0, rebuilds: 0 });
    expect(actions).toEqual(expect.arrayContaining([{ do: 'cancel', timer: 'watchdog' }, { do: 'cancel', timer: 'restart' }, { do: 'cancel', timer: 'rebuild' }, { do: 'badge', badge: 'up' }, { do: 'up' }]));
  });

  it('F: a connection that never connected waits for a rebuild, staggered and backed off by failed rebuilds', () => {
    expect(run([iceFailed]).actions).toEqual([{ do: 'cancel', timer: 'disconnect' }, { do: 'badge', badge: 'unreachable' }, { do: 'cancel', timer: 'watchdog' }, { do: 'arm', timer: 'rebuild', ms: 2_000 }]);
    expect(arms(run([iceFailed], { ctx: second }).actions)).toEqual([{ do: 'arm', timer: 'rebuild', ms: 7_000 }]);
    expect(arms(run([iceFailed], { counts: { stalled: 0, rebuilds: 2 } }).actions)).toEqual([{ do: 'arm', timer: 'rebuild', ms: 10_000 }]);
  });

  it('F: told again while a rebuild waits or runs, nothing more (the wait is not pushed out)', () => {
    expect(run([iceFailed, { on: 'connection', ice: 'failed', connection: 'failed' }, iceFailed]).actions).toEqual([{ do: 'cancel', timer: 'disconnect' }]);
    expect(arms(run([iceFailed, { on: 'timer', timer: 'rebuild', ice: 'failed', connection: 'failed' }, iceFailed]).actions)).toEqual([]);
  });

  it('F: a connection that had connected restarts after the back-off, one step further each time', () => {
    const { link, actions } = run([...up, iceFailed]);
    expect(arms(actions)).toEqual([{ do: 'arm', timer: 'restart', ms: 2_000 }]);
    expect(link.restarts).toBe(1);
    expect(arms(step(link, freshCounts(), iceFailed, first))).toEqual([{ do: 'arm', timer: 'restart', ms: 5_000 }]);
  });

  it('F: with the friend lost, the connection closes', () => {
    expect(run([...up, { on: 'lost', ice: 'connected' }, iceFailed]).actions).toEqual([{ do: 'cancel', timer: 'disconnect' }, { do: 'close' }]);
  });

  it('R5: the handshake failed while ICE is up is a failure; ICE failed with it is told once, by ICE', () => {
    expect(run([{ on: 'connection', ice: 'connected', connection: 'failed' }]).link.badge).toBe('unreachable');
    expect(run([{ on: 'connection', ice: 'failed', connection: 'failed' }]).actions).toEqual([]);
  });

  it('R6: ICE closed shows unreachable', () => {
    expect(run([...up, { on: 'ice', ice: 'closed', connection: 'closed' }]).link.badge).toBe('unreachable');
  });

  it('R7: after the disconnect grace, a restart if it had connected, a failure if never, a close if the friend is lost', () => {
    const timer: Event = { on: 'timer', timer: 'disconnect', ice: 'disconnected', connection: 'connecting' };
    expect(run([...up, timer]).actions).toEqual([{ do: 'restart' }]);
    expect(run([timer]).link.rebuild).toBe('waiting');
    expect(run([...up, { on: 'lost', ice: 'connected' }, timer]).actions).toEqual([{ do: 'close' }]);
    expect(run([...up, { ...timer, ice: 'connected' }]).actions).toEqual([]);
  });

  it('R8: the restart timer restarts ICE', () => {
    expect(run([{ on: 'timer', timer: 'restart', ice: 'failed', connection: 'connected' }]).actions).toEqual([{ do: 'restart' }]);
  });

  it('R9: the rebuild timer rebuilds keeping the stalled attempts, once at a time', () => {
    const { link, actions } = run([iceFailed, { on: 'timer', timer: 'rebuild', ice: 'failed', connection: 'failed' }], { counts: { stalled: 1, rebuilds: 0 } });
    expect(actions).toContainEqual({ do: 'rebuild', why: 'failed', stalled: 1 });
    expect(link.rebuild).toBe('running');
    expect(step(link, freshCounts(), { on: 'rebuild-now' }, first)).toEqual([]);
  });

  it('R10: a rebuild that happened counts and reports; one declined does not, and the next failure arms again', () => {
    const counts = freshCounts();
    const { link, actions } = run([iceFailed, { on: 'rebuild-now' }, { on: 'rebuilt', why: 'failed', done: true }], { counts });
    expect(actions).toEqual([{ do: 'report', event: 'peer_never_connected', rebuilds: 0 }]);
    expect(counts.rebuilds).toBe(1);
    expect(link.rebuild).toBe('none');
    const declined = run([iceFailed, { on: 'rebuild-now' }, { on: 'rebuilt', why: 'failed', done: false }]);
    expect(declined.actions).toEqual([]);
    expect(arms(step(declined.link, declined.counts, { on: 'connection', ice: 'connected', connection: 'failed' }, first))).toEqual([{ do: 'arm', timer: 'rebuild', ms: 2_000 }]);
  });

  it('R11: the watchdog rebuilds a connection still connecting, with one more stalled attempt than it was built with', () => {
    const timer: Event = { on: 'timer', timer: 'watchdog', ice: 'checking', connection: 'connecting' };
    expect(run([{ on: 'built' }, timer], { counts: { stalled: 1, rebuilds: 0 } }).actions).toEqual([{ do: 'rebuild', why: 'stuck', stalled: 2 }]);
    expect(run([...up, timer]).actions).toEqual([]);
    expect(run([{ ...timer, connection: 'closed' }]).actions).toEqual([]);
  });

  it('R12: the friend\'s socket lost clears their counts; a dead connection closes, a live one waits the grace', () => {
    const counts = { stalled: 2, rebuilds: 1 };
    expect(run([{ on: 'lost', ice: 'new' }], { counts }).actions).toEqual([{ do: 'close' }]);
    expect(counts).toEqual({ stalled: 0, rebuilds: 0 });
    const { link, actions } = run([...up, { on: 'lost', ice: 'connected' }]);
    expect(link.lost).toBe(true);
    expect(actions).toEqual([{ do: 'arm', timer: 'grace', ms: PEER_GRACE_MS }]);
  });

  it('R13: after the grace, the connection closes unless it is connected', () => {
    expect(run([{ on: 'timer', timer: 'grace', ice: 'checking', connection: 'connecting' }]).actions).toEqual([{ do: 'close' }]);
    expect(run([{ on: 'timer', timer: 'grace', ice: 'connected', connection: 'connected' }]).actions).toEqual([]);
  });

  it('R14: the friend back cancels the grace and sends again, or rebuilds a failed one that never connected', () => {
    expect(run([...up, { on: 'lost', ice: 'connected' }, { on: 'back' }]).actions).toEqual([{ do: 'cancel', timer: 'grace' }, { do: 'resend' }]);
    const failedWhileAway = run([{ on: 'lost', ice: 'checking' }, { on: 'connection', ice: 'connected', connection: 'failed' }]);
    expect(failedWhileAway.actions).toEqual([{ do: 'close' }]); // F with the friend lost
    const declined = run([iceFailed, { on: 'rebuild-now' }, { on: 'rebuilt', why: 'failed', done: false }, { on: 'back' }]);
    expect(declined.actions).toEqual([{ do: 'cancel', timer: 'watchdog' }, { do: 'arm', timer: 'rebuild', ms: 2_000 }]);
  });

  it('stillRebuild: a stuck rebuild wants the badge still connecting; a failed one, the connection still not up and the friend there', () => {
    const link = newLink(true, freshCounts());
    expect(stillRebuild(link, 'stuck', 'connecting')).toBe(true);
    expect(stillRebuild(link, 'failed', 'connected')).toBe(false);
    link.lost = true;
    expect(stillRebuild(link, 'failed', 'failed')).toBe(false);
  });
});

describe('offerPath', () => {
  const facts = (f: Partial<OfferFacts> = {}): OfferFacts => ({ held: true, namesGone: false, bothFirstOffers: false, iOfferFirst: false, theyOfferFirst: false, fresh: false, restartsIce: false, deadIce: false, ...f });
  const live = (): Link => { const l = newLink(true, freshCounts()); l.connectedOnce = true; return l; };
  const never = (rebuild: Link['rebuild'] = 'none'): Link => ({ ...newLink(true, freshCounts()), rebuild });

  it('O1: an offer for a connection of mine that is gone is dropped; with none held, only if I offer first', () => {
    expect(offerPath(live(), facts({ namesGone: true }))).toEqual({ go: 'drop', row: 'O1' });
    expect(offerPath(undefined, facts({ held: false, namesGone: true, iOfferFirst: true }))).toEqual({ go: 'drop', row: 'O1' });
    expect(offerPath(undefined, facts({ held: false, namesGone: true }))).toEqual({ go: 'apply', row: 'O5' });
  });

  it('O2: both first offers unanswered: the one to offer drops theirs, the other starts over from it', () => {
    expect(offerPath(never(), facts({ bothFirstOffers: true, iOfferFirst: true }))).toEqual({ go: 'drop', row: 'O2' });
    expect(offerPath(never(), facts({ bothFirstOffers: true, theyOfferFirst: true }))).toEqual({ go: 'fresh', row: 'O2' });
  });

  it('O3: to a connection that never connected, while its rebuild waits or runs, or restarting its ICE: dropped and rebuilt', () => {
    expect(offerPath(never('waiting'), facts())).toEqual({ go: 'drop-rebuild', row: 'O3' });
    expect(offerPath(never('running'), facts())).toEqual({ go: 'drop-rebuild', row: 'O3' });
    expect(offerPath(never(), facts({ restartsIce: true }))).toEqual({ go: 'drop-rebuild', row: 'O3' });
    expect(offerPath(never('waiting'), facts({ fresh: true }))).toEqual({ go: 'fresh', row: 'O4' });
    expect(offerPath(live(), facts({ restartsIce: true }))).toEqual({ go: 'apply', row: 'O5' });
    expect(offerPath(never(), facts())).toEqual({ go: 'apply', row: 'O5' });
  });

  it('O4: the friend lost, my ICE dead, or a new certificate: answered from a new connection', () => {
    const lost = live(); lost.lost = true;
    expect(offerPath(lost, facts())).toEqual({ go: 'fresh', row: 'O4' });
    expect(offerPath(live(), facts({ deadIce: true }))).toEqual({ go: 'fresh', row: 'O4' });
    expect(offerPath(live(), facts({ fresh: true }))).toEqual({ go: 'fresh', row: 'O4' });
  });
});
