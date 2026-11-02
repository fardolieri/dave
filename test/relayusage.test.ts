import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_FREE_BYTES, formatBytes, formatRelayUsage, monthSoFar, parseRelayBytes, parseRelayUsage, relayUsageRequest } from '../src/core/relayusage';
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
    const u = { bytes: 14066575220, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2 };
    expect(formatRelayUsage(u)).toBe('14 GB of 1 TB (1.4%)');
    expect(formatRelayUsage({ ...u, bytes: 30_000_000 })).toBe('30 MB of 1 TB (<0.1%)');
    expect(formatRelayUsage({ ...u, bytes: 0 })).toBe('0 B of 1 TB (0%)');
    expect(formatRelayUsage({ ...u, bytes: 812_000_000_000 })).toBe('812 GB of 1 TB (81%)');
    expect(formatRelayUsage({ ...u, bytes: 1_250_000_000_000 })).toBe('1.3 TB of 1 TB (125%)');
  });
  it('reads only a well-formed answer from the Worker', () => {
    const u = { bytes: 1, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2 };
    expect(parseRelayUsage(u)).toEqual(u);
    expect(parseRelayUsage({ ...u, limit: 0 })).toBeNull();
    expect(parseRelayUsage({ ...u, bytes: -1 })).toBeNull();
    expect(parseRelayUsage({ ...u, since: 'November' })).toBeNull();
    expect(parseRelayUsage({ error: 'unavailable' })).toBeNull();
  });
});

describe('the Worker’s /relay-usage', () => {
  afterEach(() => { vi.restoreAllMocks(); forgetRelayUsage(); });
  const configured = { ...env, RELAY_USAGE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' } as Env;

  it('is 204 without a token, so the dialog leaves the line out', async () => {
    const res = await exports.default.fetch('https://dave.test/relay-usage');
    expect(res.status).toBe(204);
  });
  it('answers what Cloudflare said, and asks again only after ten minutes', async () => {
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(ANSWER));
    const res = await relayUsage(configured, NOV_2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 14066575220, limit: RELAY_FREE_BYTES, since: '2026-11-01', asOf: NOV_2 });
    await relayUsage(configured, NOV_2 + 9 * 60_000);
    expect(api).toHaveBeenCalledTimes(1);
    await relayUsage(configured, NOV_2 + 11 * 60_000);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('asks once for requests that come together, and again as soon as a new month begins', async () => {
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(ANSWER));
    const both = await Promise.all([relayUsage(configured, NOV_2), relayUsage(configured, NOV_2)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(api).toHaveBeenCalledTimes(1);
    const lastOfOctober = Date.parse('2026-10-31T23:58:00Z');
    forgetRelayUsage();
    await relayUsage(configured, lastOfOctober);
    const first = parseRelayUsage(await (await relayUsage(configured, lastOfOctober + 4 * 60_000)).json());
    expect(first?.since, 'two minutes into November').toBe('2026-11-01');
    expect(api).toHaveBeenCalledTimes(3);
  });
  it('says so when Cloudflare fails, and asks again after a minute, not on every open', async () => {
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: null, errors: [{ message: 'not authorized' }] }));
    const answer = async (at: number) => parseRelayUsage(await (await relayUsage(configured, at)).json());
    expect(await answer(NOV_2)).toBeNull();
    expect(await answer(NOV_2 + 30_000)).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    api.mockImplementation(async () => Response.json(ANSWER));
    expect(await answer(NOV_2 + 61_000)).toMatchObject({ bytes: 14066575220 });
  });
});
