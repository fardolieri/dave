/**
 * Where the suite points its browsers and how they are launched, shared by playwright.config.ts (the project's own browser)
 * and the fixtures (a second engine inside one test, or a browser with autoplay blocked).
 */
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { LaunchOptions } from '@playwright/test';

const NIGHTLY = 'https://dave-nightly.danielmittereder.workers.dev';
// Its own port, not vite preview's 4173: a local run reuses a server already listening there, which must be an e2e build.
export const LOCAL_PORT = Number(process.env['E2E_PORT']) || 4179;
/** A deployed copy to drive, or undefined for the local build. Empty counts as unset: CI passes an empty E2E_URL for a local run. */
export const target: string | undefined = process.env['E2E_URL'] === 'nightly' ? NIGHTLY : process.env['E2E_URL'] || undefined;


/**
 * The origin a browser opens. A deployed copy is the same for everyone. The local build is reached on localhost by Chromium,
 * but on this machine's network address by Firefox: in CI, Firefox gathered no ICE candidates at all on any page from
 * http://localhost (2026-09-26; data: pages, https sites and the network address gathered fine). Firefox is told to treat
 * that plain-http address as secure (`dom.securecontext.allowlist`), which getUserMedia and WebCrypto need. Both reach the
 * same server, so friends in different engines still meet in one room.
 */
export function originFor(engine: Engine): string {
  if (target) return target;
  return engine === 'firefox' ? `http://${lanAddress()}:${LOCAL_PORT}` : `http://localhost:${LOCAL_PORT}`;
}
function lanAddress(): string {
  if (process.env['E2E_HOST']) return process.env['E2E_HOST'];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}

/** Console output Firefox adds that is not the app misbehaving. Chromium adds none. */
export function environmentNoise(engine: Engine): RegExp[] {
  if (engine !== 'firefox') return [];
  return [
    // posthog-js probes which domain takes a cookie; Firefox reports the refusals (an IP address, workers.dev as a public suffix).
    /Cookie “dmn_chk_[^”]*” has been rejected for invalid domain/,
    // A deployed copy hands out STUN plus Cloudflare's TURN URLs, six in all. A real hint, kept as a follow-up, not a test failure.
    /Using five or more STUN\/TURN servers slows down discovery/,
    // Icons on the plain-http network address Firefox was told to treat as secure (local runs only).
    ...(target ? [] : [/Mixed Content: Upgrading insecure display request/]),
  ];
}

export type Engine = 'chromium' | 'firefox';

// Without a sound device getUserMedia hangs in headless Chromium (seen on the 1 GB dev VM); CI runners have none either.
const noSound = process.platform === 'linux' && !existsSync('/dev/snd');

/** `allowed`: plays without a gesture (the suite's default). `default`: the browser's own policy. `blocked`: nothing plays without a fresh gesture. */
export type Autoplay = 'allowed' | 'default' | 'blocked';

export function launchOptions(engine: Engine, opts: { autoplay?: Autoplay } = {}): LaunchOptions {
  const autoplay = opts.autoplay ?? 'allowed';
  if (engine === 'firefox') {
    return {
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        // 0 allows everything; 1 is Firefox's own default (blocks audible media); 5 with policy 2 is "Block": nothing without a fresh gesture.
        'media.autoplay.default': { allowed: 0, default: 1, blocked: 5 }[autoplay],
        ...(autoplay === 'blocked' ? { 'media.autoplay.blocking_policy': 2 } : {}),
        // Every browser runs on one machine: plain host candidates connect them, where mDNS names might not resolve.
        // Playwright's Firefox build ships its own network defaults, so every host-candidate switch is set explicitly.
        'media.peerconnection.ice.obfuscate_host_addresses': false,
        'media.peerconnection.ice.no_host': false,
        'media.peerconnection.ice.default_address_only': false,
        'media.peerconnection.ice.proxy_only': false,
        'media.peerconnection.ice.relay_only': false,
        'media.peerconnection.ice.loopback': true,
        'media.peerconnection.ice.link_local': true,
        ...(target ? {} : { 'dom.securecontext.allowlist': new URL(originFor('firefox')).hostname }),
      },
    };
  }
  return {
    args: [
      '--use-fake-ui-for-media-stream', // grants microphone and screen capture without a prompt
      '--use-fake-device-for-media-stream', // a beeping microphone and a synthetic screen
      ...({ allowed: ['--autoplay-policy=no-user-gesture-required'], default: [], blocked: ['--autoplay-policy=user-gesture-required'] }[autoplay]),
      '--disable-features=WebRtcHideLocalIpsWithMdns', // same reason as the Firefox pref above
      ...(noSound ? ['--disable-audio-output'] : []),
    ],
  };
}
