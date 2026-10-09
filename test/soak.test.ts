import { describe, expect, it } from 'vitest';
import { applicable, apply, effective, format, formatList, generate, initialModel, parse, parseList, shrink, SHRINK_FIRST, type Action } from '../e2e/soak/model';

// The model of the nightly soak (e2e/soak/): a seed must give the same run every time, a report's list must read back as
// the same actions, and the shrinking must find the few actions a failure needs.
describe('soak model', () => {
  it('gives the same actions for the same seed, each one making sense where it stands', () => {
    const run = generate(42, 300);
    expect(generate(42, 300)).toEqual(run);
    expect(generate(43, 300)).not.toEqual(run);
    expect(effective(run)).toEqual(run);
    expect(new Set(run.map((a) => a.do)).size).toBeGreaterThanOrEqual(12); // a long run takes nearly every kind of action
  });

  it('only Chromium friends share, and a share ends for its viewers when it stops', () => {
    for (const a of generate(7, 500)) if (a.do === 'share') expect(['Alice', 'Carol']).toContain(a.who);
    let m = initialModel();
    for (const a of parseList('Alice join; Bob join; Alice share; Bob watch Alice')) { expect(applicable(m, a)).toBe(true); m = apply(m, a); }
    expect(m.friends.Bob.watching).toEqual(['Alice']);
    m = apply(m, parse('Alice reload'));
    expect(m.friends.Alice).toMatchObject({ inCall: true, sharing: false });
    expect(m.friends.Bob.watching).toEqual([]);
    expect(applicable(m, parse('Bob unwatch Alice'))).toBe(false);
  });

  it('reads back what it writes', () => {
    const run = generate(1, 200);
    expect(parseList(formatList(run))).toEqual(run);
    expect(format(parse('Dan volume Bob 75'))).toBe('Dan volume Bob 75');
    expect(() => parse('Eve join')).toThrow();
    expect(() => parse('Alice dance')).toThrow();
  });

  it('a shortened list drops the actions that no longer make sense', () => {
    expect(formatList(effective(parseList('Bob watch Alice; Alice join; Alice leave; Alice leave')))).toBe('Alice join; Alice leave');
  });

  it('shrinks a failing list to the actions the failure needs', async () => {
    const run = generate(5, 60);
    const needed = [run[10]!, run[37]!];
    const fails = async (l: Action[]) => needed.every((a) => l.includes(a));
    const { list, complete } = await shrink(run, fails, () => true);
    expect(list).toEqual(needed);
    expect(complete).toBe(true);
    // Dropping whole groups first finds the same.
    const grouped = await shrink(run, fails, () => true, SHRINK_FIRST);
    expect(grouped.list).toEqual(needed);
    // Out of budget, it keeps what it has.
    const cut = await shrink(run, fails, () => false);
    expect(cut).toMatchObject({ list: run, complete: false, replays: 0 });
  });
});
