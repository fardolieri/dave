import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FREE_PLAN, RELAY_FREE_BYTES, fillOf, formatBytes, formatCount, formatPercent, freePlanRequest, monthSoFar, parseFreePlan, parseRelayBytes, parseRelayUsage, relayUsageRequest, savesRelay } from '../src/core/relayusage';
import { withoutTurn } from '../src/core/turn';
import { forgetRelayUsage, relayUsage } from '../src/worker/relayusage';

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
    expect(plan.variables).toEqual({ account: 'acct', day: '2026-11-02' });
    for (const group of ['durableObjectsInvocationsAdaptiveGroups', 'workersInvocationsAdaptive', 'durableObjectsPeriodicGroups', 'durableObjectsSqlStorageGroups']) expect(plan.query).toContain(group);
  });

  it("reads today's free plan figures: requests, rows, time, and storage added up over every namespace", () => {
    const answer = { data: { viewer: { accounts: [{
      turn: [], sfu: [],
      // A frame a hibernating room is woken for is billed 20 to 1: 51,461 of them are 2,573.05 requests, shown whole.
      objects: [{ sum: { requests: 51461 }, dimensions: { type: 'hibernation' } }, { sum: { requests: 9648 }, dimensions: { type: 'http' } }, { sum: { requests: 12385 }, dimensions: { type: 'jsrpc' } }, { sum: { requests: 5126 }, dimensions: { type: 'alarm' } }],
      workers: [{ sum: { requests: 14232 } }],
      periodic: [{ sum: { rowsRead: 53650, rowsWritten: 26147, duration: 1336.5 } }],
      stored: [{ max: { storedBytes: 13_000_000 } }, { max: { storedBytes: 70_000_000 } }],
    }] } } };
    expect(parseFreePlan(answer, '2026-11-05')).toEqual({ day: '2026-11-05', objectRequests: 2573.05 + 9648 + 12385 + 5126, workerRequests: 14232, rowsWritten: 26147, rowsRead: 53650, compute: 1336.5, stored: 83_000_000 });
    // Nothing yet today: no rows in a group is nothing used.
    const quiet = { data: { viewer: { accounts: [{ turn: [], sfu: [], objects: [], workers: [], periodic: [], stored: [] }] } } };
    expect(parseFreePlan(quiet, '2026-11-05')).toEqual({ day: '2026-11-05', objectRequests: 0, workerRequests: 0, rowsWritten: 0, rowsRead: 0, compute: 0, stored: 0 });
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
  const PLAN = { data: { viewer: { accounts: [{ objects: [{ sum: { requests: 100 }, dimensions: { type: 'http' } }], workers: [{ sum: { requests: 7 } }], periodic: [{ sum: { rowsRead: 9, rowsWritten: 8, duration: 1.5 } }], stored: [{ max: { storedBytes: 1000 } }] }] } } };
  it('answers what Cloudflare said, and asks again only after ten minutes', async () => {
    const api = cloudflare();
    const res = await relayUsage(configured, NOV_2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 14066575220, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2, today: { day: '2026-11-02', objectRequests: 100, workerRequests: 7, rowsWritten: 8, rowsRead: 9, compute: 1.5, stored: 1000 } });
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
  it('says so when Cloudflare fails, and asks again after a minute, not on every open', async () => {
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: null, errors: [{ message: 'not authorized' }] }));
    const answer = async (at: number) => parseRelayUsage(await (await relayUsage(configured, at)).json());
    expect(await answer(NOV_2)).toBeNull();
    expect(await answer(NOV_2 + 30_000)).toBeNull();
    expect(api).toHaveBeenCalledTimes(2);
    api.mockImplementation(async () => Response.json(ANSWER));
    expect(await answer(NOV_2 + 61_000)).toMatchObject({ bytes: 14066575220 });
  });
});
