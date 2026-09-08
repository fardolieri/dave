#!/usr/bin/env node
// Drives real headless Chromium profiles against the app over the DevTools protocol.
// Development aid, not a test: `node scripts/drive.mjs <url> <secret> <name> [name2 ...]`
// Each name gets its own profile with the secret and name pre-seeded, so the page
// lands straight in the Room. Prints each browser's sidebar and chat, then sends one
// message from the first browser and shows what the others received.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const args = process.argv.slice(2);
const holdArg = args.find((a) => a.startsWith('--hold='));
const joinAll = args.includes('--join');
const shareToo = args.includes('--share');
const narrowLast = args.includes('--narrow-last');
const shotArg = args.find((a) => a.startsWith('--shot='));
const shotDir = shotArg ? shotArg.slice(7) : null;
const hold = holdArg ? Number(holdArg.slice(7)) : 0;
const [url, secret, ...names] = args.filter((a) => !a.startsWith('--'));
if (!url || !secret || names.length === 0) { console.error('usage: drive.mjs <url> <secret> <name> [name2 ...]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(name, port, size = '1200,800') { this.name = name; this.port = port; this.size = size; this.dir = mkdtempSync(join(tmpdir(), `dave-${name}-`)); }
  async launch() {
    const extra = (process.env.CHROME_FLAGS ?? '').split(' ').filter(Boolean); // e.g. --force-webrtc-ip-handling-policy=disable_non_proxied_udp to force TURN
    this.proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', ...extra, `--window-size=${this.size}`, `--user-data-dir=${this.dir}`, `--remote-debugging-port=${this.port}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', detached: true });
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`http://127.0.0.1:${this.port}/json/list`); const tabs = await r.json(); if (tabs.length) { this.tab = tabs[0]; break; } } catch {}
      await sleep(100);
    }
    this.ws = new WebSocket(this.tab.webSocketDebuggerUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.id = 0; this.pending = new Map();
    this.warnings = new Map();
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; const key = `EXCEPTION ${d.exception?.description?.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`; this.warnings.set(key, (this.warnings.get(key) ?? 0) + 1); }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) {
        const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 90);
        const frames = (m.params.stackTrace?.callFrames ?? []).filter((f) => f.url.includes('/src/')).slice(0, 2).map((f) => `${f.url.split('/src/')[1]}:${f.lineNumber + 1} ${f.functionName}`);
        const key = `${text} @ ${frames.join(' < ')}`;
        this.warnings.set(key, (this.warnings.get(key) ?? 0) + 1);
      }
    };
    await this.cdp('Runtime.enable');
    // UA_OVERRIDE=1: look like a normal Chrome. posthog-js drops every event from a "HeadlessChrome" user agent
    // client-side, so a run that must reach PostHog (e.g. REPORT_CHECK) needs this; leave it off otherwise.
    if (process.env.UA_OVERRIDE) {
      const ua = (await this.eval('navigator.userAgent')).replace('HeadlessChrome', 'Chrome');
      await this.cdp('Emulation.setUserAgentOverride', { userAgent: ua });
    }
  }
  cdp(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.pending.set(id, r)); }
  async eval(expression) { const r = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; }
  /** Same as eval, but counts as a user gesture so fullscreen and similar APIs are allowed. */
  async gesture(expression) { const r = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); return r.result?.result?.value; }
  async goto(u) { await this.cdp('Page.navigate', { url: u }); await sleep(800); }
  async seed() {
    await this.goto(new URL('/', url).href);
    // SEED_MUTED=1: join with the microphone muted (for runs against the live room; pair with CHROME_FLAGS=--use-file-for-fake-audio-capture=<silent.wav> so nothing hums either way).
    await this.eval(`localStorage.setItem('dave.secret', ${JSON.stringify(secret)}); localStorage.setItem('dave.name', ${JSON.stringify(this.name)}); ${process.env.SEED_MUTED ? "localStorage.setItem('dave.muted', 'true');" : ''} 'ok'`);
    await this.goto(url);
  }
  async screenshot(path, width) {
    // Emulate a phone viewport regardless of the headless window minimum.
    if (width) await this.cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const r = await this.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  }
  text(sel) { return this.eval(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map(e => e.innerText.replace(/\\s+/g,' ').trim()).join(' | ')`); }
  async say(text) {
    await this.eval(`(() => { const i = document.querySelector('.chat-input input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`);
    await sleep(50);
    await this.eval(`document.querySelector('.chat-input form, form.chat-input').requestSubmit(); 'sent'`);
  }
  /** Opens a second tab in this profile (same identity) and returns eval/text helpers bound to it. */
  async secondTab(u) {
    const before = new Set((await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).map((t) => t.id));
    await this.cdp('Target.createTarget', { url: u });
    let tab; for (let i = 0; i < 50 && !tab; i++) { tab = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()).find((t) => !before.has(t.id) && t.type === 'page'); if (!tab) await sleep(100); }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const cdp = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
    const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
    return { eval: evaluate, text: (sel) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map(e => e.innerText.replace(/\s+/g,' ').trim()).join(' | ')`), close: () => ws.close() };
  }
  close() { try { this.ws?.close(); } catch {} try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { this.proc?.kill('SIGKILL'); } setTimeout(() => { try { rmSync(this.dir, { recursive: true, force: true }); } catch {} }, 500); }
}

const portBase = Number(process.env.PORT_BASE ?? 9300);
const browsers = names.map((n, i) => new Browser(n, portBase + i));
try {
  for (const b of browsers) { await b.launch(); await b.seed(); }
  await sleep(1500);
  for (const b of browsers) console.log(`[${b.name}] banner: ${await b.text('.banner') || '(none)'}\n[${b.name}] online: ${await b.text('.plist li')}`);
  if (joinAll) {
    for (const b of browsers) { await b.eval(`document.querySelector('button.join')?.click(); 'clicked'`); await sleep(400); }
    // Watch the connection badges settle, up to 30 s, reporting when each browser first shows direct or relayed.
    const t0 = Date.now(); const settled = new Map();
    while (Date.now() - t0 < 30000 && settled.size < browsers.length) {
      await sleep(1000);
      if (process.env.TRACE_ICE) { const last = browsers[browsers.length - 1]; console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s [${last.name}] peers=${JSON.stringify(await last.eval(`window.__dave?.peers().map(p => p.name + ':' + p.ice) ?? 'no hook'`))} state=${JSON.stringify(await last.eval(`window.__dave?.state()`))}`); }
      for (const b of browsers) if (!settled.has(b.name)) {
        const badges = await b.eval(`[...document.querySelectorAll('.side ul:nth-of-type(2) .conn')].map(c => c.textContent.trim())`);
        if (badges.length === browsers.length - 1 && badges.every((x) => x === 'direct' || x === 'via relay')) { settled.set(b.name, badges); console.log(`[${b.name}] badges settled after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${badges.join(', ')}`); }
      }
    }
    for (const b of browsers) if (!settled.has(b.name)) console.log(`[${b.name}] badges NOT settled after 30s: ${await b.eval(`[...document.querySelectorAll('.side ul:nth-of-type(2) .conn')].map(c => c.textContent.trim()).join(', ')`) || '(none)'}`);
    for (const b of browsers) console.log(`[${b.name}] call: ${await b.text('.side ul:nth-of-type(2) li') || '(empty)'}\n[${b.name}] actions: ${await b.text('.actions button')} | speaking rings: ${await b.eval(`document.querySelectorAll('.avatar.speaking').length`)} (on others: ${await b.eval(`document.querySelectorAll('.side ul:nth-of-type(2) li:not(:first-child) .avatar.speaking').length`)})`);
    if (browsers[1]) {
      await browsers[1].eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Mute')?.click(); 'muted'`);
      await sleep(1500);
      console.log(`[${browsers[1].name}] own actions after mute click: ${await browsers[1].text('.actions button')}`);
      // Fake microphones beep intermittently, so sample over time: which other participants rang at least once?
      const seen = new Map(browsers.map((b) => [b.name, new Set()]));
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        for (const b of browsers) for (const n of await b.eval(`[...document.querySelectorAll('.side ul:nth-of-type(2) li:not(:first-child)')].filter(li => li.querySelector('.avatar.speaking')).map(li => li.querySelector('.pname').firstChild.textContent.trim())`)) seen.get(b.name).add(n);
      }
      for (const b of browsers) console.log(`[${b.name}] call after mute: ${await b.text('.side ul:nth-of-type(2) li')} | heard ringing: ${[...seen.get(b.name)].join(', ') || 'nobody'}`);
      for (const b of browsers) console.log(`[${b.name}] mesh: ${JSON.stringify(await b.eval(`window.__dave?.peers() ?? 'no debug hook'`))}`);
    }
    if (shareToo && browsers.length > 1) {
      const [sharer, viewer, ...rest] = browsers;
      const gap = (b) => b.eval(`(() => { const l = document.querySelector('.chat-log'); return Math.abs(Math.round(l.scrollTop)); })()`);
      if (process.env.SCROLL_CHECK) {
        // A short viewport and many lines make the log overflow; the share strip then halves it. The newest line must stay in view.
        await viewer.cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 420, deviceScaleFactor: 1, mobile: false });
        for (let i = 0; i < 14; i++) { await sharer.say(`filler line ${i}`); await sleep(120); }
        await sleep(800);
        console.log(`[${viewer.name}] gap to bottom before share (expect 0): ${await gap(viewer)}`);
        var lastTop = (b) => b.eval(`(() => { const m = document.querySelector('.chat-log .msg'); return m ? Math.round(m.getBoundingClientRect().bottom) : null; })()`); // newest line is first in the DOM
        console.log(`[${viewer.name}] last line bottom edge on screen before share: ${await lastTop(viewer)}`);
      }
      await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share'`);
      await sleep(3000);
      if (process.env.SCROLL_CHECK) {
        console.log(`[${viewer.name}] gap to bottom after the share strip appeared (expect 0): ${await gap(viewer)} | last line bottom edge (expect unchanged): ${await lastTop(viewer)}`);
        // A gap smaller than the growth: the browser must clamp scrollTop when the log grows, the case that used to lose the gap.
        await viewer.eval(`(() => { const l = document.querySelector('.chat-log'); l.scrollTop = -60; })(); 'scroll up 60px'`); await sleep(300);
        console.log(`[${viewer.name}] scrolled up a bit: gap ${await gap(viewer)} | log height ${await viewer.eval(`document.querySelector('.chat-log').clientHeight`)} | hint: ${await viewer.text('.chat-new') || '(none)'}`);
        await sharer.say('arrives while Bob reads older lines'); await sleep(600);
        console.log(`[${viewer.name}] a line arrived while scrolled up: gap (expect 108 = 60 + one line, reader not moved) ${await gap(viewer)} | hint (expect shown): ${await viewer.text('.chat-new') || '(none)'}`);
        if (shotDir) { mkdirSync(shotDir, { recursive: true }); await viewer.screenshot(`${shotDir}/${viewer.name}-new-messages-hint.png`); }
        await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Stop sharing')?.click(); 'stop'`); await sleep(1500);
        console.log(`[${viewer.name}] strip went away, log grew: gap (expect 108, unchanged): ${await gap(viewer)} | log height ${await viewer.eval(`document.querySelector('.chat-log').clientHeight`)}`);
        await viewer.eval(`document.querySelector('.chat-new')?.click(); 'jump'`); await sleep(400);
        console.log(`[${viewer.name}] after clicking the hint: gap (expect 0) ${await gap(viewer)} | hint (expect gone): ${await viewer.text('.chat-new') || '(none)'}`);
        // Few lines, tall viewport: the log does not overflow once full size; the lines must still sit at the bottom, unmoved.
        await viewer.cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false }); await sleep(300);
        await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share'`); await sleep(2500);
        const withStrip = await lastTop(viewer);
        await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Stop sharing')?.click(); 'stop'`); await sleep(1500);
        console.log(`[${viewer.name}] tall viewport: last line bottom edge with strip ${withStrip}, after strip went away (expect same): ${await lastTop(viewer)} | overflow now: ${await viewer.eval(`(() => { const l = document.querySelector('.chat-log'); return l.scrollHeight > l.clientHeight; })()`)}`);
        if (shotDir) { mkdirSync(shotDir, { recursive: true }); await viewer.screenshot(`${shotDir}/${viewer.name}-chat-full.png`); }
        await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share again'`); await sleep(3000);
        await viewer.cdp('Emulation.clearDeviceMetricsOverride');
      }
      for (const b of browsers) console.log(`[${b.name}] tiles: ${await b.text('.share') || '(none)'}`);
      console.log(`[${sharer.name}] mesh before anyone watches: ${JSON.stringify(await sharer.eval(`window.__dave?.peers().map(p => ({ name: p.name, subscribedToMe: p.subscribedToMe }))`))}`);
      const bytesBefore = Object.fromEntries(await Promise.all(browsers.slice(1).map(async (b) => [b.name, (await b.eval(`window.__dave?.peers().find(p => p.name === ${JSON.stringify(sharer.name)})?.videoBytesIn ?? -1`))])));
      await viewer.eval(`[...document.querySelectorAll('.share')].find(t => t.textContent.includes(${JSON.stringify(sharer.name)}))?.click(); 'watch'`);
      await sleep(5000);
      const bytesAfter = Object.fromEntries(await Promise.all(browsers.slice(1).map(async (b) => [b.name, (await b.eval(`window.__dave?.peers().find(p => p.name === ${JSON.stringify(sharer.name)})?.videoBytesIn ?? -1`))])));
      console.log(`share bytes before/after ${viewer.name} clicked: ${JSON.stringify({ before: bytesBefore, after: bytesAfter })}`);
      console.log(`[${viewer.name}] tile now: ${await viewer.text('.share')}`);
      for (const b of rest) console.log(`[${b.name}] tile (never subscribed): ${await b.text('.share')}`);
      console.log(`[${sharer.name}] mesh after: ${JSON.stringify(await sharer.eval(`window.__dave?.peers().map(p => ({ name: p.name, subscribedToMe: p.subscribedToMe }))`))}`);
      await sharer.eval(`document.querySelector('.actions .gear')?.click(); 'audio gear'`);
      await sleep(600);
      console.log(`[${sharer.name}] audio panel: ${await sharer.text('.panel')}`);
      await sharer.eval(`[...document.querySelectorAll('.panel input[type=checkbox]')][1]?.click(); 'toggle noise suppression'`);
      await sleep(600);
      console.log(`[${sharer.name}] after toggling noise suppression: ${(await sharer.text('.panel .warn')) || '(no warning)'} | ${JSON.stringify(await sharer.eval(`window.__dave?.audio()`))}`);
      await sharer.eval(`document.querySelector('.actions .gear')?.click(); 'close audio'`);
      await sleep(300);
      // Settings: flip the sharer to the Motion preset and read back what reached the track and the senders.
      await sharer.eval(`[...document.querySelectorAll('.actions .gear')].pop()?.click(); 'gear'`);
      await sleep(300);
      await sharer.eval(`[...document.querySelectorAll('.panel .presets button')].find(b => b.textContent === 'Motion')?.click(); 'motion'`);
      await sleep(2500);
      console.log(`[${sharer.name}] share after Motion preset: ${JSON.stringify(await sharer.eval(`window.__dave?.share()`))}`);
      if (rest[0]) {
        // Second sharer: the viewer shares too; the third browser watches both, then drops one.
        const third = rest[0];
        await viewer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share2'`);
        await sleep(2500);
        await third.eval(`[...document.querySelectorAll('.share')].forEach(t => t.click()); 'watch both'`);
        await sleep(5000);
        console.log(`[${third.name}] watching both: ${await third.text('.share')}`);
        const b1 = await third.eval(`Object.fromEntries(window.__dave.peers().map(p => [p.name, p.videoBytesIn]))`);
        await third.eval(`[...document.querySelectorAll('.share')].find(t => t.textContent.includes(${JSON.stringify(sharer.name)}))?.click(); 'unwatch first'`);
        await sleep(4000);
        const b2 = await third.eval(`Object.fromEntries(window.__dave.peers().map(p => [p.name, p.videoBytesIn]))`);
        await sleep(3000);
        const b3 = await third.eval(`Object.fromEntries(window.__dave.peers().map(p => [p.name, p.videoBytesIn]))`);
        console.log(`[${third.name}] bytes at unwatch of ${sharer.name}: ${JSON.stringify(b1)} -> ${JSON.stringify(b2)} -> ${JSON.stringify(b3)} (first should stop growing, second keeps growing)`);
        console.log(`[${third.name}] tiles after unwatch: ${await third.text('.share')}`);
      }
      if (process.env.REPORT_CHECK) {
        // The viewer files a problem report while watching; the dialog must confirm, and the event carries a snapshot.
        await viewer.eval(`document.querySelector('.report-link button')?.click(); 'open'`); await sleep(300);
        await viewer.eval(`(() => { const t = document.querySelector('dialog.report textarea'); t.value = 'automated test report from the driver, please ignore'; t.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`); await sleep(200);
        await viewer.eval(`[...document.querySelectorAll('dialog.report .row button')].find(b => b.textContent === 'Send')?.click(); 'send'`); await sleep(2500);
        console.log(`[${viewer.name}] report dialog says: ${await viewer.text('dialog.report .ok, dialog.report .warn') || '(nothing yet)'} | dialog open: ${await viewer.eval(`document.querySelector('dialog.report').open`)}`);
        if (shotDir) { mkdirSync(shotDir, { recursive: true }); await viewer.screenshot(`${shotDir}/${viewer.name}-report.png`); }
        await viewer.eval(`[...document.querySelectorAll('dialog.report .row button')].find(b => b.textContent === 'Close')?.click(); 'close'`); await sleep(200);
        console.log(`[${viewer.name}] diagnostics sample: ${JSON.stringify(await viewer.eval(`(async () => { const d = await window.__dave?.diagnostics?.(); return d ? { inCall: d.inCall, peers: d.peers.map(p => ({ conn: p.view.conn, watching: p.view.watching, live: p.view.shareLive, decoded: p.inboundVideo?.framesDecoded, key: p.inboundVideo?.keyFramesDecoded, codec: p.inboundVideo?.codec, pair: p.pair })) } : 'no hook'; })()`))}`);
      }
      if (process.env.LEAVE_CHECK) {
        // Leave while sharing, then rejoin: nothing may still claim I am sharing.
        await sharer.eval(`document.querySelector('button.leave')?.click(); 'leave'`); await sleep(1500);
        console.log(`[${sharer.name}] after leave while sharing: actions=${await sharer.text('.actions button, button.join')} | share=${JSON.stringify(await sharer.eval(`window.__dave?.share()`))} | tiles=${await sharer.text('.share') || '(none)'} | online=${await sharer.text('.plist li')}`);
        await sharer.eval(`document.querySelector('button.join')?.click(); 'join'`); await sleep(2500);
        console.log(`[${sharer.name}] after rejoin: actions=${await sharer.text('.actions button')} | share=${JSON.stringify(await sharer.eval(`window.__dave?.share()`))} | tiles=${await sharer.text('.share') || '(none)'} | call=${await sharer.text('.plist li')}`);
        console.log(`[${viewer.name}] sees: tiles=${await viewer.text('.share') || '(none)'} | call=${await viewer.text('.plist li')}`);
      }
      if (process.env.FULLSCREEN_CHECK) {
        // Click a running tile: the tile goes fullscreen. Click again: back. Stop watching has its own button.
        // Fullscreen ends by itself when the share ends or I leave.
        const fsState = async (b) => `fullscreen=${await b.eval(`document.fullscreenElement ? document.fullscreenElement.className.split(' ')[0] : null`)} watching=${await b.eval(`window.__dave?.peers().find(p => p.name === ${JSON.stringify(sharer.name)})?.watching`)}`;
        const tile = `[...document.querySelectorAll('.share')].find(t => t.textContent.includes(${JSON.stringify(sharer.name)}))`;
        console.log(`[${sharer.name}] own bar: ${await sharer.text('.share-own .share-bar')}`);
        console.log(`[${viewer.name}] bar: ${await viewer.text('.share .share-bar')}`);
        await viewer.gesture(`${tile}?.click(); 'tile'`); await sleep(800);
        console.log(`[${viewer.name}] after clicking the running tile (expect fullscreen=share): ${await fsState(viewer)} | bar: ${await viewer.text('.share-fs .share-bar')}`);
        if (shotDir) { mkdirSync(shotDir, { recursive: true }); await viewer.screenshot(`${shotDir}/${viewer.name}-fullscreen.png`); }
        await sleep(3000);
        console.log(`[${viewer.name}] overlays after 3 s without movement (expect hidden): ${await viewer.eval(`document.fullscreenElement?.classList.contains('share-idle')`)} | bar opacity: ${await viewer.eval(`getComputedStyle(document.querySelector('.share-fs .share-bar')).opacity`)}`);
        if (shotDir) await viewer.screenshot(`${shotDir}/${viewer.name}-fullscreen-idle.png`);
        await viewer.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 }); await sleep(400);
        console.log(`[${viewer.name}] after moving the mouse (expect shown): ${await viewer.eval(`document.fullscreenElement?.classList.contains('share-idle')`)} | bar opacity: ${await viewer.eval(`getComputedStyle(document.querySelector('.share-fs .share-bar')).opacity`)}`);
        await viewer.gesture(`document.fullscreenElement?.click(); 'click again'`); await sleep(500);
        console.log(`[${viewer.name}] after clicking again (expect fullscreen=null, still watching): ${await fsState(viewer)}`);
        await viewer.eval(`document.querySelector('.share .stop')?.click(); 'stop watching'`); await sleep(800);
        console.log(`[${viewer.name}] after Stop watching (expect watching=false): ${await fsState(viewer)} | tile: ${await viewer.text('.share')}`);
        await viewer.eval(`${tile}?.click(); 'watch'`); await sleep(3000);
        await viewer.gesture(`${tile}?.click(); 'fullscreen'`); await sleep(800);
        console.log(`[${viewer.name}] watching and fullscreen again: ${await fsState(viewer)}`);
        await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Stop sharing')?.click(); 'stop'`); await sleep(1500);
        console.log(`[${viewer.name}] after sharer stopped (expect fullscreen=null): ${await fsState(viewer)}`);
        await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share again'`); await sleep(2500);
        await viewer.eval(`${tile}?.click(); 'watch'`); await sleep(3000);
        await viewer.gesture(`${tile}?.click(); 'fullscreen'`); await sleep(800);
        console.log(`[${viewer.name}] fullscreen once more: ${await fsState(viewer)}`);
        await viewer.eval(`document.querySelector('button.leave')?.click(); 'leave'`); await sleep(800);
        console.log(`[${viewer.name}] after leaving the call (expect fullscreen=null): ${await fsState(viewer)}`);
      }
    }
    if (shotDir) {
      if (process.env.OPEN_PANELS) {
        const a = browsers[0];
        await a.eval(`document.querySelector('.actions .gear')?.click(); 'audio gear'`);
        await a.eval(`document.querySelector('.prow button.vol')?.click(); 'slider'`);
        await sleep(400);
      }
      mkdirSync(shotDir, { recursive: true });
      for (const b of browsers) await b.screenshot(`${shotDir}/${b.name}.png`, narrowLast && b === browsers[browsers.length - 1] ? 390 : undefined);
      console.log(`screenshots in ${shotDir}`);
    }
    if (process.env.VOLUME_CHECK && browsers[1]) {
      const [a, b] = browsers;
      await a.eval(`[...document.querySelectorAll('.prow')].find(li => li.textContent.includes(${JSON.stringify(b.name)}))?.querySelector('button.vol')?.click(); 'open'`);
      await sleep(300);
      await a.eval(`(() => { const r = document.querySelector('.volrow input[type=range]'); r.value = '150'; r.dispatchEvent(new Event('input', { bubbles: true })); return 'set'; })()`);
      await sleep(500);
      console.log(`[${a.name}] volumes after slider: ${JSON.stringify(await a.eval(`window.__dave?.volumes()`))} | row: ${await a.text('.prow button.vol')}`);
      await a.goto(url); await sleep(1500);
      await a.eval(`document.querySelector('button.join')?.click(); 'rejoin'`); await sleep(4000);
      console.log(`[${a.name}] volumes after reload and rejoin: ${JSON.stringify(await a.eval(`window.__dave?.volumes()`))} | row: ${await a.text('.prow button.vol')}`);
    }
    // Chatter while in the call: messages from both sides, interleaved.
    for (let i = 0; i < 3; i++) {
      for (const b of browsers) { await b.say(`${b.name} in-call message ${i}`); await sleep(250); }
    }
    await sleep(800);
    for (const b of browsers) console.log(`[${b.name}] in-call chat lines: ${await b.eval(`document.querySelectorAll('.chat-log .msg').length`)}`);
    const last = browsers[browsers.length - 1];
    if (browsers.length > 1) {
      await last.eval(`document.querySelector('button.leave')?.click(); 'left'`);
      await sleep(1500);
      console.log(`[${last.name}] own actions after leave: ${await last.text('.actions button')} | online: ${await last.text('.side ul:nth-of-type(1) li')}`);
      console.log(`[${browsers[0].name}] call after ${last.name} left: ${await browsers[0].text('.side ul:nth-of-type(2) li')}`);
    }
  }
  await browsers[0].say(`hello from ${browsers[0].name} https://example.com`);
  await sleep(800);
  await browsers[0].say('second message');
  await sleep(500);
  await browsers[0].say('third one, no link');
  await sleep(800);
  if (process.env.TABS_CHECK && browsers[1]) {
    // A second tab of the same browser shares the identity: the server keeps one socket per identity,
    // the older tab steps back with a banner, and "Use it here instead" turns the tables.
    const [a, b] = browsers;
    const tab2 = await a.secondTab(url); await sleep(2500);
    console.log(`[${a.name} tab 1] banner: ${await a.text('.banner') || '(none)'} | in call: ${await a.eval(`window.__dave?.state().inCall`)}`);
    console.log(`[${a.name} tab 2] banner: ${await tab2.text('.banner') || '(none)'} | online: ${await tab2.text('.plist li')}`);
    console.log(`[${b.name}] sees ${a.name} how many times: ${await b.eval(`[...document.querySelectorAll('.plist li')].filter(li => li.textContent.includes(${JSON.stringify(a.name)})).length`)} | list: ${await b.text('.plist li')}`);
    await a.eval(`document.querySelector('.banner button')?.click(); 'take over'`); await sleep(2500);
    console.log(`[${a.name} tab 1] after take-over: ${await a.text('.banner') || '(none)'} | online: ${await a.text('.plist li')}`);
    console.log(`[${a.name} tab 2] after take-over: ${await tab2.text('.banner') || '(none)'}`);
    console.log(`[${b.name}] sees ${a.name} how many times: ${await b.eval(`[...document.querySelectorAll('.plist li')].filter(li => li.textContent.includes(${JSON.stringify(a.name)})).length`)}`);
    tab2.close();
  }
  if (process.env.HISTORY_CHECK && browsers[1]) {
    const [a, b] = browsers;
    console.log(`[${b.name}] cues heard: ${await b.eval('window.__daveCues?.() ?? "no hook"')} | [${a.name}] cues heard (own messages): ${await a.eval('window.__daveCues?.() ?? "no hook"')}`);
    // Two socket drops leave two dated notes with their downtime; they survive a reload like the messages.
    await b.eval(`window.__dave?.dropSocket(); 'drop'`); await sleep(3000);
    await b.eval(`window.__dave?.dropSocket(); 'drop again'`); await sleep(3000);
    console.log(`[${b.name}] notes after two socket drops (expect two): ${await b.text('.chat-log .msg-sys') || '(none)'}`);
    if (shotDir) { mkdirSync(shotDir, { recursive: true }); await b.screenshot(`${shotDir}/${b.name}-history.png`); }
    const before = await b.eval(`document.querySelectorAll('.chat-log .msg:not(.msg-sys)').length`);
    await b.goto(url); await sleep(2500);
    console.log(`[${b.name}] messages before reload: ${before}, after reload: ${await b.eval(`document.querySelectorAll('.chat-log .msg:not(.msg-sys)').length`)} | notes after reload: ${await b.text('.chat-log .msg-sys') || '(none)'} | tools: ${await b.text('.chat-tools')}`);
    await b.eval(`document.querySelector('.chat-tools button')?.click(); 'cleared'`); await sleep(500);
    console.log(`[${b.name}] after clear: ${await b.eval(`document.querySelectorAll('.chat-log .msg').length`)} messages`);
  }
  for (const b of browsers) console.log(`[${b.name}] chat: ${await b.text('.chat-log .msg, .chat-log .msg-sys')}`);
  const warn = await browsers[0].text('.warn');
  if (warn) console.log(`[${browsers[0].name}] warning: ${warn}`);
  if (hold) {
    // Let the operator disturb the server meanwhile, then report what the browsers show.
    for (let t = 0; t < hold; t += 2000) {
      await sleep(2000);
      console.log(`t+${(t + 2000) / 1000}s [${browsers[0].name}] banner: ${await browsers[0].text('.banner') || '(none)'}`);
    }
    for (const b of browsers) console.log(`[${b.name}] final banner: ${await b.text('.banner') || '(none)'}\n[${b.name}] final chat: ${await b.text('.chat-log .msg, .chat-log .msg-sys')}\n[${b.name}] final online: ${await b.text('.plist li')}`);
  }
} finally {
  for (const b of browsers) for (const [k, n] of b.warnings ?? []) console.log(`[${b.name}] console.warn x${n}: ${k}`);
  for (const b of browsers) b.close();
}
