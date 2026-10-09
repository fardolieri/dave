/**
 * The friend group from hell (quality ticket 05): a nightly chaos soak, run by .github/workflows/soak.yml and kept out of
 * the normal suite (playwright.config.ts ignores e2e/soak/). Four friends, Chromium and Firefox mixed, share a room and take
 * seeded random actions (model.ts). After every step what everyone sees is checked against the model, with real polling
 * waits: who is online and in the call, mute and share flags, share tiles and which are watched, connections, volumes,
 * share settings, texts, that every friend in the call hears every unmuted one, and no console warning nobody expected
 * (the invariant watchdog's `[invariant] …` lines among them, ticket 04).
 *
 * A failing run replays its list in fresh rooms to see the failure again, shrinks it (model.ts, `shrink`) to a shorter
 * list that fails the same way, records a trace of the shortest one, and writes soak-out/report.{md,json} for the
 * workflow to turn into an issue.
 *
 *   SOAK_SEED=7 SOAK_MINUTES=15        a run of 15 minutes from seed 7 (a random seed when unset)
 *   SOAK_SEED=7 SOAK_STEPS=40          exactly the first 40 actions of seed 7
 *   SOAK_ACTIONS="Alice join; …"       exactly these actions (the minimal list of a report)
 *   SOAK_SHRINK_MINUTES=20             the time the shrinking may take; 0 skips it
 *
 *   E2E_URL=nightly pnpm exec playwright test -c playwright.soak.config.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { launchOptions, target } from '../browsers';
import { Friend, expect, newSecret, test, type RoomSeed } from '../fixtures';
import { FRIENDS, NAMES, applicable, apply, effective, engineOf, format, formatList, generate, initialModel, parseList, participants, sharers, shrink, volumeOf, type Action, type Model, type Name } from './model';

const env = process.env;
const SEED = env['SOAK_SEED'] ? Number(env['SOAK_SEED']) : Math.floor(Math.random() * 1e9);
const STEPS = env['SOAK_STEPS'] ? Number(env['SOAK_STEPS']) : null;
const ACTIONS = env['SOAK_ACTIONS']?.trim() ? parseList(env['SOAK_ACTIONS']) : null;
const MINUTES = Number(env['SOAK_MINUTES'] ?? 15);
const SHRINK_MINUTES = Number(env['SOAK_SHRINK_MINUTES'] ?? 20);
const OUT = env['SOAK_OUT'] ?? 'soak-out';
/** How long what everyone sees may take to match the model after a step: a reconnect, an ICE restart, a rebuild. */
const SETTLE_MS = 60_000;
/** At least this long per step. A deployed Worker limits socket upgrades per IP (wrangler.jsonc), and reloads, cuts and
 * reconnects each open one: at most a few a minute at this pace. */
const MIN_STEP_MS = 1500;
const MIN = 60_000;

type Browsers = Record<'chromium' | 'firefox', Browser>;
type Failure = { step: number; action: Action | null; problems: string[]; kinds: string[] };
type Outcome = { steps: number; failure: Failure | null; aborted: boolean };

const log = (s: string) => console.log(`[soak] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n').find((l) => l.trim())?.trim().slice(0, 300) ?? 'unknown error';
/** What kind of difference a line reports, without names: "tile of Bob: …" → "tile"; "invariant share_opening". */
function kindOf(problem: string): string {
  const invariant = /\[invariant\] (\w+)/.exec(problem)?.[1];
  return invariant ? `invariant ${invariant}` : problem.split(':')[0]!.replace(/ (of|to) \w+$/, '');
}

/** Four friends in a fresh room, and the model of what they should see. */
class Group {
  readonly friends = new Map<Name, Friend>();
  model: Model = initialModel();
  readonly room: RoomSeed = { secret: newSecret(), name: 'Soak' };

  static async open(browsers: Browsers, tracing: boolean): Promise<Group> {
    const g = new Group();
    for (const { name, engine } of FRIENDS) {
      const f = new Friend(name, { rooms: [g.room] });
      g.friends.set(name, f);
      await f.launch(browsers[engine], engine);
      if (tracing) await f.context.tracing.start({ screenshots: true, snapshots: true });
      await f.open();
    }
    return g;
  }

  of(n: Name): Friend { return this.friends.get(n)!; }

  async close(traceDir?: string): Promise<void> {
    for (const [n, f] of this.friends) {
      if (traceDir) await f.context.tracing.stop({ path: join(traceDir, `trace-${n}.zip`) }).catch(() => {});
      await f.close();
    }
  }

  /** What each friend's socket carried and their problems, next to the report. Frames only, the room secret left out. */
  keep(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const [n, f] of this.friends) writeFileSync(join(dir, `${n}-wire.json`), redact(JSON.stringify({ problems: f.problems, frames: f.wire.log }, null, 1), this.room.secret));
  }

  /** Does the action, the way a friend would, through the suite's helpers. */
  async act(a: Action): Promise<void> {
    const f = this.of(a.who);
    switch (a.do) {
      case 'join': return f.join();
      case 'leave': return f.leave();
      case 'mute': await f.button('Mute').click(); await expect(f.button('Unmute')).toBeVisible(); return;
      case 'unmute': await f.button('Unmute').click(); await expect(f.button('Mute')).toBeVisible(); return;
      case 'share': return f.startShare();
      case 'unshare': return f.stopShare();
      case 'watch': return f.watchShare(a.of);
      case 'unwatch':
        await f.tile(a.of).getByRole('button', { name: 'Stop watching' }).click();
        await expect(f.tile(a.of)).toHaveClass(/share-closed/);
        return;
      case 'volume': {
        const row = rowOf(f, a.of);
        await row.locator('button.vol').click();
        await row.locator('.volrow input[type=range]').fill(String(a.value));
        await row.locator('button.vol').click();
        return;
      }
      case 'settings':
        await f.selectedRoom.getByTitle('Share settings').click();
        await f.page.locator('.panel label', { hasText: /^Frame rate/ }).locator('select').selectOption(String(a.frameRate));
        await f.page.locator('.panel label', { hasText: /^Resolution/ }).locator('select').selectOption(String(a.maxHeight));
        await f.selectedRoom.getByTitle('Share settings').click();
        return;
      case 'say': return f.say(a.text);
      case 'reload':
        await f.page.reload();
        await f.connected();
        if (this.model.friends[a.who].inCall) await expect(f.button('Leave')).toBeVisible(); // a reload rejoins (ticket 24)
        return;
      case 'hide':
        // The page is told it is hidden, as when the friend switches tabs: what the app reads (visibilityState, the
        // visibilitychange event). The browser does not throttle its timers as it would for a real background tab.
        await f.page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          Object.defineProperty(document, 'hidden', { value: true, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await f.page.waitForTimeout(a.seconds * 1000);
        await f.page.evaluate(() => {
          delete (document as unknown as { visibilityState?: unknown }).visibilityState;
          delete (document as unknown as { hidden?: unknown }).hidden;
          document.dispatchEvent(new Event('visibilitychange'));
        });
        return;
      case 'cut':
        await f.wire.cut();
        await f.page.waitForTimeout(a.seconds * 1000);
        f.wire.restore();
        // The next attempt comes after the back-off (client/room.ts), a few seconds after a short outage.
        await expect(f.composer).toBeEnabled({ timeout: 35_000 });
        return;
      case 'offline':
        await f.context.setOffline(true);
        await f.page.waitForTimeout(a.seconds * 1000);
        await f.context.setOffline(false);
        await expect(f.composer).toBeEnabled({ timeout: 35_000 });
        return;
    }
  }

  /** Where what the friends see differs from the model, one line each, "<what>: <who> …". Empty when all agree. */
  async differences(): Promise<string[]> {
    const m = this.model;
    const out: string[] = [];
    const inCall = participants(m);
    const visitors = NAMES.filter((n) => !inCall.includes(n));
    const shares = sharers(m);
    for (const [n, f] of this.friends) {
      const problems = await f.unexpectedProblems();
      for (const p of problems) out.push(/\[invariant\]/.test(p) ? `invariant: ${n}: ${p}` : `console: ${n}: ${p}`);
      if (!(await f.composer.evaluateAll((els) => els.some((e) => !(e as HTMLInputElement).disabled)))) { out.push(`server: ${n} is not connected`); continue; }
      const me = m.friends[n];
      const differ = (what: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${what}: ${n} sees ${JSON.stringify(got)}, should see ${JSON.stringify(want)}`); };
      differ('call list', (await f.inCall()).sort(), [...inCall].sort());
      differ('online list', (await f.online()).sort(), [...visitors].sort());
      differ('share tiles', (await f.page.locator('.share .share-head > span:first-child').allInnerTexts()).sort(), shares.map((s) => (s === n ? 'Your screen' : `${s}'s screen`)).sort());
      for (const x of inCall) {
        const flags = await rowOf(f, x).locator('.pflags em').allInnerTexts();
        differ(`flags of ${x}`, flags.filter((t) => t === 'muted' || t === 'sharing').sort(), [...(m.friends[x].muted ? ['muted'] : []), ...(m.friends[x].sharing ? ['sharing'] : [])]);
      }
      differ('texts', await f.chatTexts(), m.texts);
      for (const s of shares.filter((s) => s !== n)) {
        const state = (await f.tile(s).evaluateAll((els) => els.map((e) => /share-(\w+)/.exec(e.className)?.[1] ?? '?')))[0] ?? 'missing';
        differ(`tile of ${s}`, state, !me.inCall ? 'locked' : me.watching.includes(s) ? 'live' : 'closed');
      }
      if (!me.inCall) continue;
      for (const x of inCall.filter((x) => x !== n)) {
        const badge = (await f.badge(x).allInnerTexts())[0]?.trim() ?? 'no badge';
        if (!/^(direct|via relay)$/.test(badge)) out.push(`link to ${x}: ${n} shows "${badge}"`);
      }
      const volumes = await f.hook<{ peers: Array<{ name: string; voiceGain: number | null }> }>('volumes');
      for (const x of inCall.filter((x) => x !== n)) {
        const gain = volumes.peers.find((p) => p.name === x)?.voiceGain ?? null;
        const want = volumeOf(m, n, x) / 100;
        if (gain === null || Math.abs(gain - want) > 0.01) out.push(`volume: ${n}'s gain for ${x} is ${gain}, should be ${want}`);
      }
      const share = await f.hook<{ settings: { frameRate: number; maxHeight: number } }>('share');
      differ('share settings', { frameRate: share.settings.frameRate, maxHeight: share.settings.maxHeight }, { frameRate: me.frameRate, maxHeight: me.maxHeight });
    }
    return out;
  }

  /** Polls until what everyone sees matches the model, then until every friend in the call hears every unmuted one. */
  async settle(): Promise<string[]> {
    const deadline = Date.now() + SETTLE_MS;
    let last: string[] = [];
    for (;;) {
      last = await this.differences();
      // A console problem does not go away by waiting.
      if (!last.length || last.some((d) => /^(console|invariant):/.test(d)) || Date.now() > deadline) break;
      await sleep(1000);
    }
    if (last.length) return last;
    return this.hearing(Math.max(deadline - Date.now(), 20_000));
  }

  /** Audio bytes from every unmuted participant keep arriving at every other one, as `Friend.hearing` checks for one. */
  async hearing(ms: number): Promise<string[]> {
    const inCall = participants(this.model);
    const pairs = inCall.flatMap((n) => inCall.filter((x) => x !== n && !this.model.friends[x].muted).map((x) => [n, x] as const));
    const bytes = async () => {
      const got = new Map<string, number>();
      for (const n of inCall) for (const p of await this.of(n).peers()) got.set(`${n}<${p.name}`, p.audioBytesIn);
      return got;
    };
    const before = await bytes();
    const deadline = Date.now() + ms;
    let deaf = pairs;
    while (deaf.length && Date.now() < deadline) {
      await sleep(1000);
      const now = await bytes();
      // A rebuilt connection counts from zero again: any change with something received is audio arriving.
      deaf = deaf.filter(([n, x]) => { const k = `${n}<${x}`; return !((now.get(k) ?? 0) > 0 && now.get(k) !== before.get(k)); });
    }
    return deaf.map(([n, x]) => `hearing: ${n} hears nothing from ${x}`);
  }
}

const rowOf = (f: Friend, of: Name) => f.selectedRoom.locator('li.prow').filter({ has: f.page.locator('.nm', { hasText: new RegExp(`^${of}( \\(you\\))?$`) }) });
const redact = (s: string, secret: string) => s.split(secret).join('<room secret>');

/**
 * Plays a list in a fresh room. Actions that make no sense at that point (in a shortened list) are skipped. Stops at the
 * first step after which what everyone sees differs from the model, or at `stopAt`.
 */
async function play(browsers: Browsers, list: Action[], o: { stopAt: number; keep?: string; trace?: string; verbose?: boolean }): Promise<Outcome> {
  const g = await Group.open(browsers, !!o.trace);
  let steps = 0;
  let failure: Failure | null = null;
  let aborted = false;
  try {
    const opening = await g.settle();
    if (opening.length) failure = { step: 0, action: null, problems: opening, kinds: [...new Set(opening.map(kindOf))] };
    for (const a of failure ? [] : list) {
      if (Date.now() > o.stopAt) { aborted = true; break; }
      if (!applicable(g.model, a)) continue;
      steps++;
      const started = Date.now();
      let problems: string[];
      try {
        await g.act(a);
        g.model = apply(g.model, a);
        problems = await g.settle();
      } catch (e) {
        g.model = apply(g.model, a);
        problems = [`action ${a.do}: ${format(a)} failed: ${firstLine(e)}`];
      }
      if (o.verbose) log(`${String(steps).padStart(3)} ${format(a).padEnd(28)} ${problems.length ? 'FAILED' : 'ok'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      if (problems.length) {
        failure = { step: steps, action: a, problems: problems.map((p) => redact(p, g.room.secret)), kinds: [...new Set(problems.map(kindOf))] };
        break;
      }
      await sleep(Math.max(0, MIN_STEP_MS - (Date.now() - started)));
    }
    if (failure && o.keep) g.keep(o.keep);
  } finally {
    if (o.trace) mkdirSync(o.trace, { recursive: true });
    await g.close(o.trace);
  }
  return { steps, failure, aborted };
}

test('the friend group from hell', async ({ browser, playwright }) => {
  const started = Date.now();
  const playUntil = ACTIONS || STEPS !== null ? Infinity : started + MINUTES * MIN;
  const shrinkUntil = () => Date.now() + SHRINK_MINUTES * MIN;
  test.setTimeout(((ACTIONS || STEPS !== null ? 60 : MINUTES) + SHRINK_MINUTES + 15) * MIN);
  const list = ACTIONS ?? generate(SEED, STEPS ?? 5000);
  log(ACTIONS ? `replaying ${ACTIONS.length} given actions` : `seed ${SEED}, ${STEPS !== null ? `${STEPS} steps` : `${MINUTES} minutes`}`);
  const firefox = await playwright.firefox.launch(launchOptions('firefox'));
  const browsers: Browsers = { chromium: browser, firefox };
  mkdirSync(OUT, { recursive: true });
  try {
    const first = await play(browsers, list, { stopAt: playUntil, keep: join(OUT, 'run'), verbose: true });
    const ran = effective(list).slice(0, first.steps);
    log(`${first.steps} steps in ${((Date.now() - started) / MIN).toFixed(1)} min: ${first.failure ? 'FAILED' : 'all as expected'}`);
    if (!first.failure) return;
    const failure = first.failure;
    for (const p of failure.problems) log(`  ${p}`);
    log(`seed ${SEED}; actions: ${formatList(ran)}`);

    // Seen again in fresh rooms? Then shrink: a shorter list counts when it fails in at least one of the same ways.
    const until = shrinkUntil();
    const more = () => Date.now() < until;
    const sameWay = (o: Outcome) => !!o.failure && o.failure.kinds.some((k) => failure.kinds.includes(k));
    let reproduced = 0, replays = 0;
    let minimal = ran;
    let complete = false;
    if (failure.step > 0 && SHRINK_MINUTES > 0) {
      const again = await play(browsers, ran, { stopAt: until });
      replays++;
      if (sameWay(again)) {
        reproduced++;
        log('the failure comes back on a replay; shrinking');
        const result = await shrink(ran, async (l) => {
          const o = await play(browsers, l, { stopAt: until });
          const yes = sameWay(o);
          if (yes) reproduced++;
          log(`  ${effective(l).length} steps: ${yes ? 'fails' : o.aborted ? 'out of time' : 'passes'}`);
          return yes;
        }, more);
        minimal = effective(result.list);
        replays += result.replays;
        complete = result.complete;
        log(`shortest list that fails: ${minimal.length} steps (${complete ? 'minimal' : 'the time for shrinking ran out'}): ${formatList(minimal)}`);
      } else log(`the failure did not come back on a replay${again.failure ? ` (it failed another way: ${again.failure.kinds.join(', ')})` : ''}`);
    }
    // A trace of the shortest list, which the report points at; the first run would be too long to trace.
    const traced = await play(browsers, minimal, { stopAt: Date.now() + 30 * MIN, trace: join(OUT, 'trace'), keep: join(OUT, 'trace') });
    report({ failure, ran, minimal, complete, reproduced, replays, tracedFails: !!traced.failure && sameWay(traced), minutes: (Date.now() - started) / MIN });
    throw new Error(`the soak found a difference at step ${failure.step} (${failure.action ? format(failure.action) : 'opening'}):\n${failure.problems.join('\n')}\nshortest failing list: ${formatList(minimal)}`);
  } finally {
    await firefox.close();
  }
});

/** soak-out/report.json for the workflow, and report.md: the issue body and the job summary. */
function report(r: { failure: Failure; ran: Action[]; minimal: Action[]; complete: boolean; reproduced: number; replays: number; tracedFails: boolean; minutes: number }): void {
  const { failure, ran, minimal } = r;
  const sequence = formatList(minimal);
  const hash = createHash('sha256').update(sequence).digest('hex').slice(0, 12);
  const targetInput = env['SOAK_TARGET'] ?? (target ? 'nightly' : 'local');
  const runUrl = env['SOAK_RUN_URL'];
  const shrunk = minimal.length < ran.length;
  const replayList = `gh workflow run soak.yml -f target=${targetInput} -f actions="${sequence}"`;
  const replaySeed = ACTIONS ? null : `gh workflow run soak.yml -f target=${targetInput} -f seed=${SEED} -f steps=${ran.length}`;
  const title = `Soak: ${failure.kinds.join(', ')} after ${minimal.length} step${minimal.length === 1 ? '' : 's'}${r.reproduced === 0 ? ' (did not come back on a replay)' : ''}`;
  const md = [
    `**${failure.kinds.join(', ')}** at step ${failure.step} (\`${failure.action ? format(failure.action) : 'opening the room'}\`) of a soak against ${targetInput}${env['SOAK_COMMIT'] ? ` at ${env['SOAK_COMMIT'].slice(0, 7)}` : ''}, seed ${ACTIONS ? 'none (a given list)' : SEED}.${runUrl ? ` [Run](${runUrl}), with the trace of the shortest list in its artifact.` : ''}`,
    '',
    'What differed from the model:',
    ...failure.problems.slice(0, 12).map((p) => `- ${p.slice(0, 400)}`),
    '',
    r.reproduced === 0
      ? `It did not come back on a fresh replay of the same ${ran.length} steps${failure.step === 0 ? ' (it failed while the room opened)' : ''}: a timing bug, or a flake of the soak. Not shrunk.`
      : `${shrunk ? `Shrunk from ${ran.length} to **${minimal.length} steps**` : `Not shorter than ${ran.length} steps`}${r.complete ? '' : ' (the time for shrinking ran out; a shorter one may exist)'}. It failed the same way in ${r.reproduced} of ${r.replays} replays${r.tracedFails ? ', and again in the traced one' : ', but not in the traced one'}.`,
    '',
    '```',
    ...minimal.map(format),
    '```',
    '',
    'Replay:',
    '```sh',
    replayList,
    ...(replaySeed ? [replaySeed] : []),
    '```',
    ...(shrunk ? ['', `<details><summary>The whole run (${ran.length} steps)</summary>`, '', '```', formatList(ran), '```', '</details>'] : []),
    '',
    `<!-- soak-sequence: ${hash} -->`,
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), md);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ title, hash, seed: ACTIONS ? null : SEED, target: targetInput, kinds: failure.kinds, steps: ran.length, minimal: sequence, reproduced: r.reproduced, minutes: Math.round(r.minutes) }, null, 1));
  log(`report written to ${OUT}/report.md`);
}
