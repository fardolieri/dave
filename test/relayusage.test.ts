import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALERT_SHARES, FREE_PLAN, LIVE_NAMESPACES, RELAY_FREE_BYTES, RUN_COST, SIDE_SHARES, alertStep, dayEnds, elapsedOf, fillOf, fullestOf, roomFor, sideOf, usedUp, formatBytes, formatCount, formatPercent, freePlanRequest, monthSoFar, parseFreePlan, parseRelayBytes, parseRelayUsage, relayUsageRequest, savesRelay } from '../src/core/relayusage';
import { withoutTurn } from '../src/core/turn';
import { forgetFreePlanFigure, forgetRelayUsage, relayUsage, usedUpToday } from '../src/worker/relayusage';
import worker from '../src/worker/index';
import { CLOSE_USED_UP } from '../src/core/protocol';
import { roomIdOf } from '../src/core/rooms';

// The answer Cloudflare's GraphQL API gave for this account on 2026-11-02, TURN only (no SFU rows).
const ANSWER = { data: { viewer: { accounts: [{ sfu: [], turn: [{ sum: { egressBytes: 14066575220 } }] }] } }, errors: null };
const NOV_2 = Date.parse('2026-11-02T12:51:00Z');

describe('relay usage, as Cloudflare is asked and answers', () => {
  it('asks for the month so far, UTC, for the whole account', () => {
    expect(monthSoFar(NOV_2)).toEqual({ from: '2026-11-01', to: '2026-11-02' });
    expect(monthSoFar(Date.parse('2026-12-31T23:59:59Z'))).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    const req = relayUsageRequest('acct', 'tok', NOV_2);
    expect(req.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(req.headers.authorization).toBe('Bearer tok');
    const body = JSON.parse(req.body) as { query: string; variables: unknown };
    expect(body.variables).toEqual({ account: 'acct', from: '2026-11-01', to: '2026-11-02' });
    expect(body.query).toContain('callsTurnUsageAdaptiveGroups');
    expect(body.query).toContain('callsUsageAdaptiveGroups');
    expect(body.query).not.toContain('keyId'); // every key: the allowance is the account's
    // The free plan's figures for today (UTC), for the whole account: asked apart, so a refusal leaves the relay's.
    for (const group of ['durableObjectsInvocationsAdaptiveGroups', 'workersInvocationsAdaptive']) expect(body.query).not.toContain(group);
    const plan = JSON.parse(freePlanRequest('acct', 'tok', NOV_2).body) as { query: string; variables: unknown };
    expect(plan.variables).toEqual({ account: 'acct', day: '2026-11-02', live: 'dave' });
    for (const group of ['durableObjectsInvocationsAdaptiveGroups', 'workersInvocationsAdaptive', 'durableObjectsPeriodicGroups', 'durableObjectsSqlStorageGroups']) expect(plan.query).toContain(group);
  });

  it("reads today's free plan figures: requests, rows, time, and storage added up over every namespace, and the live site's part", () => {
    const [room, store] = LIVE_NAMESPACES;
    const preview = 'ffffffffffffffffffffffffffffffff';
    const answer = { data: { viewer: { accounts: [{
      turn: [], sfu: [],
      // A frame a hibernating room is woken for is billed 20 to 1: 51,461 of them are 2,573.05 requests, shown whole.
      objects: [
        { sum: { requests: 51461 }, dimensions: { type: 'hibernation', namespaceId: preview } }, { sum: { requests: 9648 }, dimensions: { type: 'http', namespaceId: preview } },
        { sum: { requests: 12385 }, dimensions: { type: 'jsrpc', namespaceId: store } }, { sum: { requests: 5126 }, dimensions: { type: 'alarm', namespaceId: room } }, { sum: { requests: 2000 }, dimensions: { type: 'hibernation', namespaceId: room } },
      ],
      workers: [{ sum: { requests: 14232 } }],
      liveWorkers: [{ sum: { requests: 4232 } }],
      periodic: [{ sum: { rowsRead: 50000, rowsWritten: 26000, duration: 1300 }, dimensions: { namespaceId: preview } }, { sum: { rowsRead: 3650, rowsWritten: 147, duration: 36.5 }, dimensions: { namespaceId: room } }],
      stored: [{ max: { storedBytes: 13_000_000 } }, { max: { storedBytes: 70_000_000 } }],
    }] } } };
    const today = parseFreePlan(answer, '2026-11-05')!;
    expect(today).toEqual({
      day: '2026-11-05', objectRequests: 2573.05 + 9648 + 12385 + 5126 + 100, workerRequests: 14232, rowsWritten: 26147, rowsRead: 53650, compute: 1336.5, stored: 83_000_000,
      live: { objectRequests: 12385 + 5126 + 100, workerRequests: 4232, rowsWritten: 147, rowsRead: 3650, compute: 36.5 },
    });
    // The previews: everything that is not the live site's.
    expect(sideOf(today, 'preview')).toEqual({ objectRequests: 2573.05 + 9648, workerRequests: 10000, rowsWritten: 26000, rowsRead: 50000, compute: 1300 });
    // Nothing yet today: no rows in a group is nothing used.
    const quiet = { data: { viewer: { accounts: [{ turn: [], sfu: [], objects: [], workers: [], liveWorkers: [], periodic: [], stored: [] }] } } };
    const none = { objectRequests: 0, workerRequests: 0, rowsWritten: 0, rowsRead: 0, compute: 0 };
    expect(parseFreePlan(quiet, '2026-11-05')).toEqual({ day: '2026-11-05', ...none, stored: 0, live: none });
    // The live site's Worker not asked about (an answer of another shape): not known, rather than all the previews'.
    expect(parseFreePlan({ data: { viewer: { accounts: [{ ...quiet.data.viewer.accounts[0], liveWorkers: undefined }] } } }, '2026-11-05')).toBeNull();
    // An answer from before the groups were asked, an odd value, or errors: not known.
    expect(parseFreePlan({ data: { viewer: { accounts: [{ turn: [], sfu: [] }] } } }, '2026-11-05')).toBeNull();
    expect(parseFreePlan({ data: { viewer: { accounts: [{ ...quiet.data.viewer.accounts[0], objects: [{ sum: { requests: '5' } }] }] } } }, '2026-11-05')).toBeNull();
    expect(parseFreePlan({ errors: [{ message: 'no' }] }, '2026-11-05')).toBeNull();
  });

  it('prints counts and shares as the About dialog shows them, and says how full a meter is', () => {
    expect(formatCount(940)).toBe('940');
    expect(formatCount(62736)).toBe('62,736');
    expect(formatCount(1_234_567)).toBe('1.2 M');
    expect(formatCount(5_000_000)).toBe('5 M');
    expect(formatCount(13_000)).toBe('13,000');
    expect(formatCount(29732.05)).toBe('29,732');
    expect(formatPercent(78634, 100000)).toBe('79');
    expect(formatPercent(53650, 5_000_000)).toBe('1.1');
    expect(formatPercent(1, 5_000_000)).toBe('<0.1');
    expect(formatPercent(0, 100)).toBe('0');
    expect([fillOf(49, 100), fillOf(50, 100), fillOf(79, 100), fillOf(80, 100), fillOf(120, 100)]).toEqual(['ok', 'warn', 'warn', 'bad', 'bad']);
    expect(FREE_PLAN.objectRequests).toBe(100_000);
  });
  it('adds TURN and SFU egress, counts no rows as nothing sent, and refuses errors and odd shapes', () => {
    expect(parseRelayBytes(ANSWER)).toBe(14066575220);
    expect(parseRelayBytes({ data: { viewer: { accounts: [{ turn: [{ sum: { egressBytes: 5 } }], sfu: [{ sum: { egressBytes: 7 } }] }] } } })).toBe(12);
    expect(parseRelayBytes({ data: { viewer: { accounts: [{ turn: [], sfu: [] }] } } })).toBe(0);
    expect(parseRelayBytes({ data: null, errors: [{ message: 'cannot request data older than 4w4d' }] })).toBeNull();
    expect(parseRelayBytes({ data: { viewer: { accounts: [] } } })).toBeNull();
    expect(parseRelayBytes({ data: { viewer: { accounts: [{ turn: [{ sum: { egressBytes: '5' } }], sfu: [] }] } } })).toBeNull();
    expect(parseRelayBytes(null)).toBeNull();
  });
});

describe('relay usage, as the About dialog shows it', () => {
  it('prints bytes in powers of 1000, as Cloudflare bills them, and the share of the free terabyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(830_000_000)).toBe('830 MB');
    expect(formatBytes(14066575220)).toBe('14 GB');
    expect(formatBytes(2_560_000_000)).toBe('2.6 GB');
    expect(formatBytes(RELAY_FREE_BYTES)).toBe('1 TB');
    const share = (bytes: number) => `${formatBytes(bytes)} of ${formatBytes(RELAY_FREE_BYTES)} (${formatPercent(bytes, RELAY_FREE_BYTES)}%)`;
    expect(share(14066575220)).toBe('14 GB of 1 TB (1.4%)');
    expect(share(30_000_000)).toBe('30 MB of 1 TB (<0.1%)');
    expect(share(0)).toBe('0 B of 1 TB (0%)');
    expect(share(812_000_000_000)).toBe('812 GB of 1 TB (81%)');
    expect(share(1_250_000_000_000)).toBe('1.3 TB of 1 TB (125%)');
  });
  it('reads only a well-formed answer from the Worker', () => {
    const u = { bytes: 1, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2 };
    expect(parseRelayUsage(u)).toEqual(u);
    const today = { day: '2026-11-02', objectRequests: 1, workerRequests: 2, rowsWritten: 3, rowsRead: 4, compute: 5.5, stored: 6 };
    expect(parseRelayUsage({ ...u, today })).toEqual({ ...u, today });
    expect(parseRelayUsage({ ...u, today: { ...today, stored: -1 } }), 'the relay without a figure that does not parse').toEqual(u);
    const live = { objectRequests: 50, workerRequests: 5, rowsWritten: 1, rowsRead: 2, compute: 0.5 };
    expect(parseRelayUsage({ ...u, today: { ...today, live } }), "the live site's part").toEqual({ ...u, today: { ...today, live } });
    expect(parseRelayUsage({ ...u, today: { ...today, live: { ...live, compute: 'a lot' } } }), "a part not whole is left out, the day's figures kept").toEqual({ ...u, today });
    expect(parseRelayUsage({ ...u, limit: 0 })).toBeNull();
    expect(parseRelayUsage({ ...u, bytes: -1 })).toBeNull();
    expect(parseRelayUsage({ ...u, since: 'November' })).toBeNull();
    expect(parseRelayUsage({ error: 'unavailable' })).toBeNull();
  });
});

describe('keeping shares and files off the relay', () => {
  const u = { bytes: 0, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2 };
  it('from 80 % of the free terabyte this month on, and not on last month’s figure or an unknown one', () => {
    expect(savesRelay({ ...u, bytes: 799_999_999_999 }, NOV_2)).toBe(false);
    expect(savesRelay({ ...u, bytes: 800_000_000_000 }, NOV_2)).toBe(true);
    expect(savesRelay({ ...u, bytes: 1_200_000_000_000 }, NOV_2)).toBe(true);
    expect(savesRelay({ ...u, bytes: 900_000_000_000, since: '2026-10-01' }, NOV_2), 'October’s, read in November').toBe(false);
    expect(savesRelay(null, NOV_2)).toBe(false);
  });
  it('gives a file link Cloudflare’s STUN only, as minted', () => {
    // The shape Cloudflare's generate-ice-servers answers, after orderIceServers.
    const minted = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp'], username: 'u', credential: 'c' },
      { urls: ['turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u', credential: 'c' },
    ];
    expect(withoutTurn(minted)).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: ['stun:stun.cloudflare.com:3478'] }]);
    expect(withoutTurn([{ urls: 'turn:x:3478', username: 'u', credential: 'c' }])).toEqual([]);
  });
});

describe('the Worker’s /relay-usage', () => {
  afterEach(() => { vi.restoreAllMocks(); forgetRelayUsage(); });
  const configured = { ...env, RELAY_USAGE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' } as Env;

  it('is 204 without a token, so the dialog leaves the line out', async () => {
    const res = await exports.default.fetch('https://dave.test/relay-usage');
    expect(res.status).toBe(204);
  });
  /** Cloudflare as the tests have it: the relay's answer, and the free plan's (`plan`, a refusal when null). */
  const cloudflare = (plan: unknown = PLAN) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    String((init as RequestInit | undefined)?.body).includes('durableObjectsInvocationsAdaptiveGroups') ? Response.json(plan ?? { data: null, errors: [{ message: 'not authorized' }] }) : Response.json(ANSWER));
  const PLAN = { data: { viewer: { accounts: [{ objects: [{ sum: { requests: 100 }, dimensions: { type: 'http', namespaceId: LIVE_NAMESPACES[0] } }], workers: [{ sum: { requests: 7 } }], liveWorkers: [{ sum: { requests: 5 } }], periodic: [{ sum: { rowsRead: 9, rowsWritten: 8, duration: 1.5 } }], stored: [{ max: { storedBytes: 1000 } }] }] } } };
  it('answers what Cloudflare said, and asks again only after ten minutes', async () => {
    const api = cloudflare();
    const res = await relayUsage(configured, NOV_2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 14066575220, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2, today: { day: '2026-11-02', objectRequests: 100, workerRequests: 7, rowsWritten: 8, rowsRead: 9, compute: 1.5, stored: 1000, live: { objectRequests: 100, workerRequests: 5, rowsWritten: 0, rowsRead: 0, compute: 0 } } });
    await relayUsage(configured, NOV_2 + 9 * 60_000);
    expect(api).toHaveBeenCalledTimes(2); // the relay's and the free plan's
    await relayUsage(configured, NOV_2 + 11 * 60_000);
    expect(api).toHaveBeenCalledTimes(4);
  });
  it("keeps each figure apart: a refused free plan is asked again after a minute, the relay's not, and a new day asks for the day's alone", async () => {
    const plans = () => api.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.body).includes('durableObjectsInvocationsAdaptiveGroups')).length;
    let api = cloudflare(null);
    expect(await (await relayUsage(configured, NOV_2)).json(), "the relay's figure all the same").toEqual({ bytes: 14066575220, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2 });
    await relayUsage(configured, NOV_2 + 61_000);
    expect([api.mock.calls.length, plans()], 'the free plan asked again, the relay not').toEqual([3, 2]);
    api.mockRestore();
    api = cloudflare();
    expect(parseRelayUsage(await (await relayUsage(configured, NOV_2 + 2 * 61_000)).json())?.today?.day).toBe('2026-11-02');
    // Past midnight, UTC, four minutes after the last ask: the day's figures at once, the relay's kept.
    await relayUsage(configured, Date.parse('2026-11-02T23:58:00Z'));
    api.mockClear();
    const nov3 = parseRelayUsage(await (await relayUsage(configured, Date.parse('2026-11-03T00:02:00Z'))).json());
    expect(nov3?.today?.day).toBe('2026-11-03');
    expect([api.mock.calls.length, plans()]).toEqual([1, 1]);
  });
  it('asks once for requests that come together, and again as soon as a new month begins', async () => {
    const api = cloudflare();
    const both = await Promise.all([relayUsage(configured, NOV_2), relayUsage(configured, NOV_2)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(api).toHaveBeenCalledTimes(2);
    const lastOfOctober = Date.parse('2026-10-31T23:58:00Z');
    forgetRelayUsage();
    await relayUsage(configured, lastOfOctober);
    const first = parseRelayUsage(await (await relayUsage(configured, lastOfOctober + 4 * 60_000)).json());
    expect(first?.since, 'two minutes into November').toBe('2026-11-01');
    expect(api).toHaveBeenCalledTimes(6);
  });
  it('ticket 76: a request waiting for a call that never ends answers within six seconds, and the next one asks anew', async () => {
    // On Cloudflare a request the browser gives up on is cancelled with its call to the API, and that call then neither
    // answers nor fails for anyone waiting on it (preview of #129, 2026-11-09: a request canceled after 1.2 s, then the
    // next one at the same edge waited until its client gave up). Here, as a call that never settles.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const api = cloudflare();
      api.mockImplementationOnce(() => new Promise<Response>(() => {})).mockImplementationOnce(() => new Promise<Response>(() => {}));
      void relayUsage(configured, NOV_2); // the request that was cancelled: never answered
      let answered: unknown = null;
      void relayUsage(configured, NOV_2).then(async (res) => { answered = await res.json(); });
      /** Lets what is due happen: the real clock, which the fake one does not move. */
      const settle = async () => { for (let i = 0; i < 20 && answered === null; i++) await scheduler.wait(5); };
      await vi.advanceTimersByTimeAsync(5900);
      await settle();
      expect(answered, 'still waiting while the call could end').toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      await settle();
      expect(answered, 'answered, the figures not known').toEqual({ error: 'unavailable' });
      expect(parseRelayUsage(await (await relayUsage(configured, NOV_2)).json()), 'the next request asks anew').toMatchObject({ bytes: 14066575220 });
      expect(api).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it("answers not known rather than last month's figure when the new month's call is not answered in time", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const api = cloudflare();
      await relayUsage(configured, Date.parse('2026-10-31T23:58:00Z')); // October's figure, kept
      api.mockImplementationOnce(() => new Promise<Response>(() => {})).mockImplementationOnce(() => new Promise<Response>(() => {}));
      let answered: unknown = null;
      void relayUsage(configured, Date.parse('2026-11-01T00:01:00Z')).then(async (res) => { answered = await res.json(); });
      await vi.advanceTimersByTimeAsync(6100);
      for (let i = 0; i < 20 && answered === null; i++) await scheduler.wait(5);
      expect(answered).toEqual({ error: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
  it("hands the call it starts to the request's waitUntil, so the requests waiting for it get its answer should its browser leave", async () => {
    cloudflare();
    const kept: Promise<unknown>[] = [];
    await relayUsage(configured, NOV_2, (call) => kept.push(call));
    expect(kept, "the relay's call and the free plan's").toHaveLength(2);
    kept.length = 0;
    await relayUsage(configured, NOV_2, (call) => kept.push(call));
    expect(kept, 'nothing asked: the answer is kept').toHaveLength(0);
  });
  it('says so when Cloudflare fails, and asks again after a minute, not on every open', async () => {
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: null, errors: [{ message: 'not authorized' }] }));
    const answer = async (at: number) => parseRelayUsage(await (await relayUsage(configured, at)).json());
    expect(await answer(NOV_2)).toBeNull();
    expect(await answer(NOV_2 + 30_000)).toBeNull();
    expect(api).toHaveBeenCalledTimes(2);
    api.mockImplementation(async () => Response.json(ANSWER));
    expect(await answer(NOV_2 + 61_000)).toMatchObject({ bytes: 14066575220 });
  });

  it('says how far through its day or month a limit is, UTC, for the pace line', () => {
    expect(elapsedOf('day', Date.UTC(2026, 10, 5, 0))).toBe(0);
    expect(elapsedOf('day', Date.UTC(2026, 10, 5, 18))).toBe(0.75);
    expect(elapsedOf('month', Date.UTC(2026, 10, 1))).toBe(0);
    expect(elapsedOf('month', Date.UTC(2026, 10, 16))).toBe(0.5); // November: 30 days
    expect(elapsedOf('month', Date.UTC(2026, 1, 15))).toBe(0.5); // February 2026: 28 days
  });
});

describe("each side's share of the day's limits: the live site's, the previews' (tickets 84, 89)", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); forgetRelayUsage(); });
  const NOV_16 = Date.parse('2026-11-16T18:00:00Z');
  const none = { objectRequests: 0, workerRequests: 0, rowsWritten: 0, rowsRead: 0, compute: 0 };
  /** A day on which the live site used `live` of Durable Object time, and the previews `previews`. */
  const used = (live: number, previews = 0, day = '2026-11-16') => ({ day, ...none, compute: live + previews, stored: 0, live: { ...none, compute: live } });

  it('a side has used its share from half of a limit on, its own use counted, for the day the figure is of; never without a share or a figure', () => {
    expect(SIDE_SHARES).toEqual({ live: 0.25, preview: 0.65 });
    // One namespace of the live site's per Durable Object class it binds: a class added to it is a namespace to add to
    // LIVE_NAMESPACES (its id from the namespaces API), or its use would be counted as the previews'.
    const classes = Object.entries(env).filter(([name, v]) => !name.startsWith('__VITEST') && !!v && typeof v === 'object' && 'idFromName' in v);
    expect(classes.length, 'LIVE_NAMESPACES lists one per class').toBe(LIVE_NAMESPACES.length);
    expect(usedUp(used(6_499.9), NOV_16, 'live', 0.5)).toBeNull();
    expect(usedUp(used(6_500), NOV_16, 'live', 0.5)).toBe('compute');
    expect(usedUp(used(6_499.9, 6_600), NOV_16, 'live', 0.5), "the previews' use is not the live site's").toBeNull();
    expect(usedUp(used(6_499.9, 6_600), NOV_16, 'preview', 0.5), 'the previews: all that is not the live site').toBe('compute');
    expect(usedUp(used(6_600, 6_499.9), NOV_16, 'preview', 0.5)).toBeNull();
    expect(usedUp(used(13_217, 0, '2026-11-15'), NOV_16, 'live', 0.5), "yesterday's figure").toBeNull();
    expect(usedUp(used(13_217), NOV_16, 'live', undefined), 'no share').toBeNull();
    expect(usedUp(used(13_217), NOV_16, 'live', 0), 'no share: the paid plan').toBeNull();
    expect(usedUp(null, NOV_16, 'live', 0.5), 'not known').toBeNull();
    expect(usedUp({ ...used(13_217), live: undefined }, NOV_16, 'preview', 0.5), "the live site's part not known").toBeNull();
    // Any daily limit: 2026-11-17 at 20:44 UTC, when the previews' runs had used the account's requests to Durable Objects.
    const nov17 = { day: '2026-11-17', objectRequests: 100_000, workerRequests: 60_000, rowsWritten: 9_310, rowsRead: 37_142, compute: 690, stored: 0, live: { objectRequests: 13_264, workerRequests: 7_744, rowsWritten: 773, rowsRead: 15_394, compute: 104 } };
    expect(usedUp(nov17, Date.parse('2026-11-17T20:44:00Z'), 'preview', 0.5)).toBe('objectRequests');
    expect(fullestOf(nov17, 'preview')).toEqual({ limit: 'objectRequests', share: (100_000 - 13_264) / 65_000 });
    expect(usedUp(nov17, Date.parse('2026-11-17T20:44:00Z'), 'live', 0.5)).toBeNull();
    // Whether one more run of the browser suite fits in the previews' share (preview.yml, scripts/gate-mode.mjs).
    const morning = { day: '2026-11-18', objectRequests: 45_552, workerRequests: 20_945, rowsWritten: 9_000, rowsRead: 40_000, compute: 1_500, stored: 0, live: { objectRequests: 348, workerRequests: 46, rowsWritten: 5, rowsRead: 1_216, compute: 1.4 } };
    expect(roomFor(morning, 'preview', RUN_COST), '45,204 + 8,000 of 65,000').toBe(true);
    expect(roomFor({ ...morning, objectRequests: 58_000 }, 'preview', RUN_COST), '57,652 + 8,000').toBe(false);
    expect(roomFor({ ...morning, live: undefined }, 'preview', RUN_COST), 'not known').toBeNull();
    expect(dayEnds(NOV_16)).toBe(Date.parse('2026-11-17T00:00:00Z'));
    expect(dayEnds(Date.parse('2026-12-31T23:59:59Z'))).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it("the watch tells at 70 and 90 % of a side's share of the daily limit it used most of, and leaves out what is stored", () => {
    expect(ALERT_SHARES).toEqual([0.7, 0.9]);
    // The afternoon of 2026-11-16, as /relay-usage had it at 19:07 UTC, the live site's rooms kept awake (ticket 84).
    const live = { objectRequests: 30_000, workerRequests: 8_000, rowsWritten: 900, rowsRead: 20_000, compute: 10_106 };
    const outage = { day: '2026-11-16', objectRequests: 38508.5, workerRequests: 16006, rowsWritten: 17921, rowsRead: 56359, compute: 13216.46, stored: 227504130, live };
    expect(fullestOf(outage, 'live')).toEqual({ limit: 'compute', share: 10_106 / (13_000 * SIDE_SHARES.live) });
    expect(fullestOf({ ...outage, stored: FREE_PLAN.stored, live: { ...live, compute: 100 } }, 'live')).toEqual({ limit: 'objectRequests', share: 30_000 / (100_000 * SIDE_SHARES.live) });
    expect([0, 0.699, 0.7, 0.89, 0.9, 1.02].map(alertStep)).toEqual([0, 0, 70, 70, 90, 90]);
  });

  const configured = { ...env, RELAY_USAGE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct', FREE_PLAN_SHARES: true, BUILD_TARGET: 'live' } as Env;
  /** Cloudflare's answer to the gate: the day's Durable Object time, GB-s, of the live site's rooms and a preview's. */
  const answer = (duration: number, previews = 0) => ({ data: { viewer: { accounts: [{ objects: [], workers: [], liveWorkers: [], periodic: [
    { sum: { rowsRead: 0, rowsWritten: 0, duration }, dimensions: { namespaceId: LIVE_NAMESPACES[0] } },
    { sum: { rowsRead: 0, rowsWritten: 0, duration: previews }, dimensions: { namespaceId: 'ffffffffffffffffffffffffffffffff' } },
  ], stored: [] }] } } });
  const cloudflare = (duration: number, previews = 0) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(answer(duration, previews)));
  /** The request's waitUntil, and what it was handed. */
  const kept = () => { const calls: Array<Promise<unknown>> = []; return { keep: (p: Promise<unknown>) => { calls.push(p); }, done: () => Promise.all(calls) }; };

  it('the gate is shut from our limit on, and for the rest of that day whatever Cloudflare says after; the next day starts open', async () => {
    const api = cloudflare(6_500.5);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const k = kept();
    expect(await usedUpToday(configured, NOV_16, k.keep), 'no figure yet: the socket waits for it').toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith('own share reached', expect.stringContaining('"side":"live","limit":"compute"'));
    // Cloudflare failing later, and the failure known, opens nothing: a day's use only grows.
    api.mockImplementation(async () => new Response('no', { status: 500 }));
    forgetFreePlanFigure();
    expect(await usedUpToday(configured, NOV_16 + 10 * 60_000, k.keep)).toBe(true);
    await k.done();
    expect(await usedUpToday(configured, NOV_16 + 11 * 60_000, k.keep)).toBe(true);
    // The next day starts open, with its own figure.
    api.mockImplementation(async () => Response.json(answer(0)));
    const nov17 = Date.parse('2026-11-17T00:00:30Z');
    expect(await usedUpToday(configured, nov17, k.keep)).toBe(false);
    expect(await usedUpToday(configured, nov17 + 1000, k.keep)).toBe(false);
  });

  it('with a figure of today it does not wait: Cloudflare is asked again after two minutes, half a minute near the share, never at every socket', async () => {
    let duration = 2_000;
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(answer(duration)));
    const k = kept();
    for (const at of [0, 1000, 60_000, 119_000]) { expect(await usedUpToday(configured, NOV_16 + at, k.keep)).toBe(false); await k.done(); }
    expect(api).toHaveBeenCalledTimes(1);
    duration = 3_000; // from 80 % of the share on (3,250 GB-s, the live site's), asked every half minute
    expect(await usedUpToday(configured, NOV_16 + 121_000, k.keep), 'the old figure, while the new one is asked').toBe(false);
    await k.done();
    expect(api).toHaveBeenCalledTimes(2);
    duration = 6_600;
    expect(await usedUpToday(configured, NOV_16 + 140_000, k.keep), 'not yet asked again').toBe(false);
    await k.done();
    expect(api).toHaveBeenCalledTimes(2);
    expect(await usedUpToday(configured, NOV_16 + 152_000, k.keep), 'the old figure once more').toBe(false);
    await k.done();
    expect(api).toHaveBeenCalledTimes(3);
    expect(await usedUpToday(configured, NOV_16 + 153_000, k.keep)).toBe(true);
  });

  it('a figure hours old is not gone by: the socket waits for today\'s', async () => {
    let duration = 2_500;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(answer(duration)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const k = kept();
    const morning = Date.parse('2026-11-16T15:00:00Z');
    expect(await usedUpToday(configured, morning, k.keep)).toBe(false);
    duration = 6_600; // three hours on, no socket having come to this isolate meanwhile
    expect(await usedUpToday(configured, morning + 3 * 3_600_000, k.keep)).toBe(true);
  });

  it('a socket waits a second and a half at most for a figure Cloudflare is slow with, then goes on; one that failed is not waited for again within the minute', async () => {
    let answer: (r: Response) => void = () => {};
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const k = kept();
    const before = Date.now();
    expect(await usedUpToday(configured, NOV_16, k.keep), 'not known: open').toBe(false);
    expect(Date.now() - before).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - before).toBeLessThan(4000);
    answer(new Response('no', { status: 500 }));
    await k.done();
    const again = Date.now();
    expect(await usedUpToday(configured, NOV_16 + 30_000, k.keep)).toBe(false);
    expect(Date.now() - again, 'a failure half a minute old is not asked about again').toBeLessThan(500);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("the previews' Worker stops at their share, all that is not the live site's; the live site's goes on", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cloudflare(1_000, 9_000);
    const k = kept();
    expect(await usedUpToday({ ...configured, BUILD_TARGET: 'preview' } as Env, NOV_16, k.keep)).toBe(true);
    await k.done();
    forgetRelayUsage(); // another Worker
    expect(await usedUpToday(configured, NOV_16, k.keep)).toBe(false);
  });

  it('has no share where none is set (the paid plan) or for a build of neither side, and none without the token to ask', async () => {
    const api = cloudflare(20_000, 20_000);
    const k = kept();
    for (const e of [{ ...configured, FREE_PLAN_SHARES: undefined }, { ...configured, FREE_PLAN_SHARES: false }, { ...configured, BUILD_TARGET: 'e2e' }, { ...configured, RELAY_USAGE_API_TOKEN: undefined }] as Env[]) {
      expect(await usedUpToday(e, NOV_16, k.keep)).toBe(false);
      await k.done();
      expect(await usedUpToday(e, NOV_16 + 1000, k.keep)).toBe(false);
    }
    expect(api).not.toHaveBeenCalled();
  });

  it('past its share the Worker takes a socket itself and closes it with the reason: no Room is asked', async () => {
    cloudflare(6_600);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOV_16);
    let asked = 0;
    const room = { idFromName: env.ROOM.idFromName.bind(env.ROOM), get: () => ({ fetch: () => { asked++; return Promise.resolve(new Response('a Room', { status: 418 })); } }) };
    const testEnv = { ...configured, ROOM: room, UPGRADE_LIMIT: undefined } as unknown as Env;
    const k = kept();
    const ctx = { waitUntil: k.keep, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const upgrade = async () => worker.fetch!(new Request(`https://dave.test/ws/${await roomIdOf('used-up-test-room')}`, { headers: { Upgrade: 'websocket' } }) as Parameters<NonNullable<typeof worker.fetch>>[0], testEnv, ctx);
    const res = await upgrade(); // the first socket of this isolate: it waits for the figure
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', (e) => resolve(e as CloseEvent)));
    ws.accept();
    expect((await closed).code).toBe(CLOSE_USED_UP);
    expect(asked, 'no Room was asked').toBe(0);
    await k.done();
  });
});
