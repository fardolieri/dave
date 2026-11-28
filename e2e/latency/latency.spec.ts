/**
 * Mouth to ear, browser to browser (ticket 96): Alice's microphone is the left channel of PulseAudio's `mix` sink, Bob's
 * speaker writes into its right channel, and one recording of `mix` holds both on one clock (scripts/latency/rig.sh).
 * Every scenario plays the same speech into Alice's microphone and finds how much later it comes out of Bob's speaker.
 *
 * - floor: one browser plays its own microphone straight back (capture and output, nothing else)
 * - webrtc: two plain pages, Opus over a local connection, the voice played by an <audio> element (the browser's best)
 * - webrtc-webaudio: the same, played the way dave plays it: through an AudioContext and a MediaStreamDestination into an element
 * - webrtc-destination: the same, played through an AudioContext straight to its destination
 * - dave, dave-no-noise-removal: dave itself, two friends in a call
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from '@playwright/test';
import { launchOptions, type PulseDevices } from '../browsers';
import { test } from '../fixtures';
import { delays, readWav, summary } from './analyse';

const OUT = process.env['LATENCY_OUT'] ?? 'latency-results';
const SIGNAL = process.env['LATENCY_SIGNAL'] ?? 'e2e/latency/speech.ogg';
const REPEAT = Number(process.env['LATENCY_REPEAT']) || 1;
const LOAD = Number(process.env['LATENCY_LOAD']) || 0;
const LOOPS = Number(process.env['LATENCY_LOOPS']) || 1;
const ONLY = process.env['LATENCY_ONLY'] ? process.env['LATENCY_ONLY'].split(',') : undefined;
/** PulseAudio's log at debug level (rig.sh): each underrun of a browser's speaker is a gap that may add delay for good. */
const PA_LOG = process.env['LATENCY_PA_LOG'];
const underruns = (): number => { if (!PA_LOG) return NaN; try { return (readFileSync(PA_LOG, 'utf8').match(/Implicit underrun of 'Playback'/g) ?? []).length; } catch { return NaN; } };
const ALICE: PulseDevices = { source: 'micA', sink: 'sinkA' };
const BOB: PulseDevices = { source: 'quiet.monitor', sink: 'bobout' };
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: 'inherit' });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

/** Every RTCPeerConnection and AudioContext a page makes, for the stats read around a measurement. */
const TAP = () => {
  const w = window as unknown as { __lat: { pcs: RTCPeerConnection[]; ctxs: AudioContext[] } };
  w.__lat = { pcs: [], ctxs: [] };
  const Pc = RTCPeerConnection, Ctx = AudioContext;
  window.RTCPeerConnection = function (this: unknown, ...a: ConstructorParameters<typeof RTCPeerConnection>) { const pc = new Pc(...a); w.__lat.pcs.push(pc); return pc; } as unknown as typeof RTCPeerConnection;
  window.RTCPeerConnection.prototype = Pc.prototype;
  window.AudioContext = function (this: unknown, ...a: ConstructorParameters<typeof AudioContext>) { const c = new Ctx(...a); w.__lat.ctxs.push(c); return c; } as unknown as typeof AudioContext;
  window.AudioContext.prototype = Ctx.prototype;
};

type Snap = { jbDelay: number; jbEmitted: number; jbTarget: number; playDelay: number; playSamples: number; concealed: number; samples: number; contexts: Array<{ baseMs: number; outputMs: number; rate: number; state: string }> };
/** The listener's counters: the voice's inbound-rtp (the busiest audio one), its media-playout, and every running context. */
async function snap(page: Page): Promise<Snap> {
  return page.evaluate(async () => {
    const lat = (window as unknown as { __lat: { pcs: RTCPeerConnection[]; ctxs: AudioContext[] } }).__lat;
    const s: Record<string, number> = {};
    let best = -1;
    for (const pc of lat.pcs) {
      if (pc.connectionState !== 'connected') continue;
      const st = await pc.getStats();
      st.forEach((r: Record<string, unknown> & { type: string }) => {
        if (r.type !== 'inbound-rtp' || r['kind'] !== 'audio' || (r['bytesReceived'] as number) <= best) return;
        best = r['bytesReceived'] as number;
        const p = st.get(r['playoutId'] as string) as Record<string, number> | undefined;
        Object.assign(s, { jbDelay: r['jitterBufferDelay'], jbEmitted: r['jitterBufferEmittedCount'], jbTarget: r['jitterBufferTargetDelay'], concealed: r['concealedSamples'], samples: r['totalSamplesReceived'], playDelay: p?.['totalPlayoutDelay'] ?? 0, playSamples: p?.['totalSamplesCount'] ?? 0 });
      });
    }
    const contexts = lat.ctxs.filter((c) => c.state === 'running').map((c) => ({ baseMs: Math.round(c.baseLatency * 1000), outputMs: Math.round(c.outputLatency * 1000), rate: c.sampleRate, state: c.state }));
    return { ...s, contexts } as unknown as Snap;
  });
}

type Result = ReturnType<typeof summary> & { name: string; underruns: number; jitterBufferMs: number | null; playoutMs: number | null };
const results: Result[] = [];

async function measure(name: string, listener: Page): Promise<void> {
  const wav = `${OUT}/${name}-${test.info().repeatEachIndex}-${Date.now()}.wav`;
  const before = await snap(listener);
  const underrunsBefore = underruns();
  const rec = spawn('parecord', ['-d', 'mix.monitor', '--channels=2', '--rate=48000', '--format=s16le', '--file-format=wav', wav]);
  await sleep(500);
  for (let i = 0; i < LOOPS; i++) await run('paplay', ['-d', 'mix', '--channel-map=front-left', SIGNAL]);
  await sleep(2000); // the last words still on their way
  const after = await snap(listener);
  const underrunsDuring = underruns() - underrunsBefore;
  rec.kill('SIGINT');
  await new Promise((r) => rec.on('exit', r));
  const windows = delays(readWav(wav));
  const d = (a: number, b: number) => a - b;
  const result = {
    name, at: new Date().toISOString(), load: LOAD, ...summary(windows), underruns: underrunsDuring,
    jitterBufferMs: Math.round((d(after.jbDelay, before.jbDelay) / d(after.jbEmitted, before.jbEmitted)) * 1000) || null,
    jitterTargetMs: Math.round((d(after.jbTarget, before.jbTarget) / d(after.jbEmitted, before.jbEmitted)) * 1000) || null,
    playoutMs: Math.round((d(after.playDelay, before.playDelay) / d(after.playSamples, before.playSamples)) * 1000) || null,
    concealedPct: Math.round((d(after.concealed, before.concealed) / d(after.samples, before.samples)) * 1000) / 10 || 0,
    contexts: after.contexts,
    lags: windows.map((w) => Math.round(w.lagMs)),
  };
  results.push(result);
  appendFileSync(`${OUT}/results.jsonl`, `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify({ ...result, lags: undefined }));
}

// ---- plain pages: an https origin of their own (getUserMedia wants a secure context), served by the route
const PAGE = 'https://latency.test/';
async function plainPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(TAP);
  await context.route(PAGE, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>latency</title>' }));
  const page = await context.newPage();
  await page.goto(PAGE);
  return page;
}
const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

type Play = 'element' | 'webaudio' | 'destination';
async function plainCall(name: string, play: Play): Promise<void> {
  const [a, b] = await Promise.all([chromium.launch(launchOptions('chromium', { pulse: ALICE })), chromium.launch(launchOptions('chromium', { pulse: BOB }))]);
  try {
    const [alice, bob] = await Promise.all([plainPage(a), plainPage(b)]);
    const offer = await alice.evaluate(async (mic) => {
      const pc = new RTCPeerConnection();
      const s = await navigator.mediaDevices.getUserMedia({ audio: mic });
      for (const t of s.getTracks()) pc.addTrack(t, s);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((r) => { if (pc.iceGatheringState === 'complete') r(); else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; });
      (window as unknown as { pc: RTCPeerConnection }).pc = pc;
      return pc.localDescription!.toJSON();
    }, MIC);
    const answer = await bob.evaluate(async ([offer, play]) => {
      const pc = new RTCPeerConnection();
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        if (play === 'element') { const el = new Audio(); el.srcObject = stream; void el.play(); return; }
        // As dave does: a muted element first, without which Chrome feeds no remote audio into WebAudio.
        const keep = new Audio(); keep.muted = true; keep.srcObject = stream; void keep.play();
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        ctx.createMediaStreamSource(stream).connect(gain);
        if (play === 'destination') { gain.connect(ctx.destination); return; }
        const dest = ctx.createMediaStreamDestination();
        gain.connect(dest);
        const el = new Audio(); el.srcObject = dest.stream; void el.play();
      };
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise<void>((r) => { if (pc.iceGatheringState === 'complete') r(); else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; });
      return pc.localDescription!.toJSON();
    }, [offer, play] as const);
    await alice.evaluate((ans) => (window as unknown as { pc: RTCPeerConnection }).pc.setRemoteDescription(ans), answer);
    await bob.waitForFunction(() => (window as unknown as { __lat: { pcs: RTCPeerConnection[] } }).__lat.pcs[0]?.connectionState === 'connected');
    await sleep(5000); // the jitter buffer settles
    await measure(name, bob);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
}

const want = (name: string) => !ONLY || ONLY.includes(name);

// Every scenario REPEAT times, one after another; the table at the end has a row per scenario.
test.describe.configure({ mode: 'serial', retries: 0 });
test.afterAll(() => {
  const by = new Map<string, Result[]>();
  for (const r of results) by.set(r.name, [...(by.get(r.name) ?? []), r]);
  const med = (xs: number[]) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)]! : NaN; };
  const rows = [...by].map(([name, rs]) => `| ${name} | ${rs.map((r) => r.medianMs).join(', ')} | ${med(rs.map((r) => r.medianMs))} | ${rs.map((r) => `${r.p10Ms}–${r.p90Ms}`).join(', ')} | ${rs.map((r) => `${r.matched}/${r.windows}`).join(', ')} | ${rs.map((r) => r.underruns).join(', ')} | ${rs.map((r) => r.jitterBufferMs ?? '–').join(', ')} | ${rs.map((r) => r.playoutMs ?? '–').join(', ')} |`);
  const table = [`Mouth to ear, ms (${LOAD ? `${LOAD} busy loops beside the browsers` : 'no extra load'}; each run's median over its windows)`, '',
    '| scenario | runs | median of runs | p10–p90 per run | windows matched | underruns | jitter buffer | playout |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n');
  appendFileSync(`${OUT}/summary.md`, `${table}\n\n`);
  console.log(table);
});

for (let k = 1; k <= REPEAT; k++) {
const run_ = REPEAT > 1 ? ` #${k}` : '';
test(`floor${run_}`, async () => {
  test.skip(!want('floor'));
  const b = await chromium.launch(launchOptions('chromium', { pulse: { source: 'micA', sink: 'bobout' } }));
  try {
    const page = await plainPage(b);
    await page.evaluate(async (mic) => {
      const el = new Audio();
      el.srcObject = await navigator.mediaDevices.getUserMedia({ audio: mic });
      await el.play();
    }, MIC);
    await sleep(2000);
    await measure('floor', page);
  } finally { await b.close(); }
});

for (const [name, play] of [['webrtc', 'element'], ['webrtc-webaudio', 'webaudio'], ['webrtc-destination', 'destination']] as const) {
  test(`${name}${run_}`, async () => {
    test.skip(!want(name));
    await plainCall(name, play);
  });
}

for (const [name, noiseRemoval] of [['dave', true], ['dave-no-noise-removal', false]] as const) {
  test(`${name}${run_}`, async ({ crowd }) => {
    test.skip(!want(name));
    const alice = await crowd.open('Alice', { pulse: ALICE, connect: false });
    const bob = await crowd.open('Bob', { pulse: BOB, connect: false });
    for (const f of [alice, bob]) {
      await f.context.addInitScript(TAP);
      if (!noiseRemoval) await f.context.addInitScript(() => localStorage.setItem('dave.audioSettings', JSON.stringify({ noiseRemoval: false })));
    }
    await alice.open();
    await bob.open();
    await alice.join();
    await bob.join();
    await bob.connectedTo('Alice');
    await bob.hearing('Alice');
    console.log('alice audio', JSON.stringify(await alice.hook('audio')));
    await sleep(5000);
    await measure(name, bob.page);
  });
}
}
