import { describe, expect, it } from 'vitest';
import { allStoredKeys, storedStateSnapshot } from '../src/core/storedstate';
import { STORED_STATE } from './storedstate.snapshot';

// The saved-state guard (quality ticket 02). Stored state outlives a deploy: a new default reaches only browsers that
// never stored the setting, and a new shape meets values written in the old one. Three times such a change did not
// reach friends and nobody noticed until later; this test makes the change visible while it is being written.

/** JSON with object keys sorted, so reordering fields in a default is not a change. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

const line = (id: string, v: unknown) => `  ${JSON.stringify(id)}: ${JSON.stringify(v)},`;

/** What changed for one key, part by part: the default, the shape, each fixture. */
function whatChanged(was: unknown, now: unknown): string[] {
  if (was === undefined) return ['  new in src/core/storedstate.ts'];
  if (now === undefined) return ['  no longer in src/core/storedstate.ts'];
  const parts = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object') return { value: v };
    const { fixtures, ...rest } = v as { fixtures?: Record<string, unknown> };
    return { ...rest, ...Object.fromEntries(Object.entries(fixtures ?? {}).map(([name, p]) => [`fixture "${name}" parses to`, p])) };
  };
  const [w, n] = [parts(was), parts(now)];
  return [...new Set([...Object.keys(w), ...Object.keys(n)])].filter((k) => stable(w[k]) !== stable(n[k])).flatMap((k) => [
    `  ${k}`,
    `    was ${k in w ? JSON.stringify(w[k]) : '(none)'}`,
    `    now ${k in n ? JSON.stringify(n[k]) : '(none)'}`,
  ]);
}

function changedMessage(changed: string[], now: Record<string, unknown>): string {
  return [
    `Saved state changed for: ${changed.join(', ')}`,
    '',
    ...changed.flatMap((id) => [id, ...whatChanged(STORED_STATE[id], now[id]), '']),
    'Browsers out there keep what they stored before this change, so a new default or a new shape does not reach them',
    'by itself (src/core/storedstate.ts). Do one of these:',
    '1. Migrate: make the parser turn what browsers hold into what you want them to have, add the old stored value as a',
    '   fixture in src/core/storedstate.ts if it is not one yet, and a test that feeds it through the parser and checks',
    '   the result. Then update the snapshot as in 2.',
    '2. Accept: update the snapshot as below, and add a line to the commit message saying who will not see the change,',
    '   e.g. "Friends who saved share settings before keep their old frame rate."',
    'A new key, or a new fixture for a new format: update the snapshot the same way; that needs no migration.',
    'Never edit or delete an existing fixture to make this pass: it is what browsers still hold.',
    '',
    'The snapshot update: in test/storedstate.snapshot.ts, replace (or add, or delete) the line of each key with:',
    ...changed.map((id) => (id in now ? line(id, now[id]) : `  (delete the line of ${JSON.stringify(id)})`)),
  ].join('\n');
}

describe('saved-state guard', () => {
  it('matches the snapshot: defaults, shapes, and what old stored values parse to', () => {
    const now = storedStateSnapshot();
    const ids = [...new Set([...Object.keys(STORED_STATE), ...Object.keys(now)])];
    const changed = ids.filter((id) => stable(STORED_STATE[id]) !== stable(now[id]));
    if (changed.length) expect.fail(changedMessage(changed, now));
  });

  const parsed = allStoredKeys().flatMap(({ id, entry: { parse, fixtures }, absent }) => (parse ? [{ id, parse, fixtures, absent }] : []));

  it('has a fixture for every parsed key', () => {
    for (const { id, fixtures } of parsed) expect(Object.keys(fixtures), `${id}: add a fixture of what browsers hold today`).not.toHaveLength(0);
  });

  // Worse than a missed default is a crash on old data: the app would not start for that friend.
  const junkStrings = ['', 'null', 'true', '0', '"x"', '[]', '{}', '[null]', '[1,"a",{}]', '{"a":null}', '{"pkA":"x"}', '{', 'undefined'];
  const junkValues: unknown[] = [null, 0, 'x', true, {}, [null], [1, 'a', {}], [{ from: null, at: 1, text: 'x' }], { length: 2 }];
  for (const { id, parse, fixtures, absent } of parsed) {
    describe(id, () => {
      it('reads every fixture, nothing stored, and junk without throwing', () => {
        const junk = absent === null ? junkStrings : junkValues;
        for (const raw of [absent, ...Object.values(fixtures), ...junk]) expect(() => parse(raw), `${id} given ${JSON.stringify(raw)}`).not.toThrow();
      });

      it('reads no old stored value as empty', () => {
        // A parser grown stricter would drop what a browser holds without a word, e.g. the whole address book.
        const empty = (v: unknown) => v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0);
        for (const [name, raw] of Object.entries(fixtures)) expect(empty(parse(raw)), `${id}, fixture "${name}" reads as empty`).toBe(false);
      });

      it('reads old settings with every current field, each of the default type', () => {
        const def = parse(absent);
        if (!def || typeof def !== 'object' || Array.isArray(def) || Object.keys(def).length === 0) return; // not a settings object
        for (const [name, raw] of Object.entries(fixtures)) {
          const out = parse(raw) as Record<string, unknown>;
          for (const [k, v] of Object.entries(def)) expect(typeof out[k], `${id}, fixture "${name}", field ${k}`).toBe(typeof v);
        }
      });
    });
  }
});
