import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { forgetRelayUsage, usedUpToday } from '../src/worker/relayusage';

afterEach(() => { vi.restoreAllMocks(); forgetRelayUsage(); });

// Ticket 89: on 2026-11-17 the previews' browser suites used the account's 100,000 requests to Durable Objects by
// 20:44 UTC, and every room of the live site failed with theirs until midnight. Nothing stopped the previews: the only
// limit of our own was the live site's, on Durable Object time.
it("a preview's Worker lets no new socket into a room once the previews have used their share of the day's requests to Durable Objects; the live site's goes on", async () => {
  const liveRoom = '4f5ba8a3f4464117a59e7a3a540651cd'; // the live site's Room namespace
  const previewRoom = 'ffffffffffffffffffffffffffffffff';
  // As Cloudflare had the day at about 20:30 UTC: the live site's rooms 13,264 requests, the previews' 60,000.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: { viewer: { accounts: [{
    objects: [{ sum: { requests: 13_264 }, dimensions: { type: 'alarm', namespaceId: liveRoom } }, { sum: { requests: 60_000 }, dimensions: { type: 'http', namespaceId: previewRoom } }],
    workers: [{ sum: { requests: 60_000 } }],
    liveWorkers: [{ sum: { requests: 7_744 } }],
    periodic: [{ sum: { rowsRead: 0, rowsWritten: 0, duration: 104 }, dimensions: { namespaceId: liveRoom } }],
    stored: [],
  }] } } }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const now = Date.parse('2026-11-17T20:30:00Z');
  const keep = () => {};
  const configured = { ...env, RELAY_USAGE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acct' };
  expect(await usedUpToday({ ...configured, BUILD_TARGET: 'preview' } as unknown as Env, now, keep), "the previews' Worker").toBe(true);
  forgetRelayUsage(); // another Worker, another isolate
  expect(await usedUpToday({ ...configured, BUILD_TARGET: 'live' } as unknown as Env, now, keep), "the live site's").toBe(false);
});
