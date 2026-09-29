import { describe, expect, it } from 'vitest';
import { CLOSED, closeLatch, keyedChain, unlessClosed } from '../src/core/signalchain';

const never = new Promise<never>(() => {});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('keyed chain', () => {
  it('runs the steps of one key one at a time, in order', async () => {
    const run = keyedChain(() => {});
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    void run('a', async () => { log.push('a1 start'); await gate; log.push('a1 end'); });
    const last = run('a', async () => { log.push('a2'); });
    await tick();
    expect(log).toEqual(['a1 start']);
    release();
    await last;
    expect(log).toEqual(['a1 start', 'a1 end', 'a2']);
  });

  it('keeps keys apart: a stalled key holds nobody else', async () => {
    const run = keyedChain(() => {});
    void run('a', () => never);
    let ran = false;
    await run('b', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('a step that throws is reported and the next one runs', async () => {
    const errors: unknown[] = [];
    const run = keyedChain((e) => errors.push(e));
    void run('a', async () => { throw new Error('bad offer'); });
    let ran = false;
    await run('a', async () => { ran = true; });
    expect(errors.map((e) => (e as Error).message)).toEqual(['bad offer']);
    expect(ran).toBe(true);
  });
});

describe('unless closed', () => {
  it('passes the step through while the connection is open', async () => {
    const { closed } = closeLatch();
    await expect(unlessClosed(closed, Promise.resolve(7))).resolves.toBe(7);
    await expect(unlessClosed(closed, Promise.reject(new Error('InvalidStateError')))).rejects.toThrow('InvalidStateError');
  });

  it('ends a step that never settles once its connection is closed', async () => {
    const latch = closeLatch();
    const step = unlessClosed(latch.closed, never);
    latch.close();
    await expect(step).rejects.toBe(CLOSED);
  });

  // Ticket 35, flake 1: a close during setRemoteDescription held that friend's later signals, the next connection's too.
  it('a close mid-step frees the chain for the next connection', async () => {
    const run = keyedChain(() => {});
    const first = closeLatch();
    const outcome: string[] = [];
    void run('bob', async () => {
      try { await unlessClosed(first.closed, never); } catch (e) { outcome.push(e === CLOSED ? 'closed' : 'error'); }
    });
    const second = closeLatch();
    const next = run('bob', async () => { outcome.push(await unlessClosed(second.closed, Promise.resolve('answer applied'))); });
    await tick();
    expect(outcome).toEqual([]);
    first.close();
    await next;
    expect(outcome).toEqual(['closed', 'answer applied']);
  });
});
