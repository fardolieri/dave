#!/usr/bin/env node
// Drives real headless Chromium profiles against the app over the DevTools protocol.
// Development aid, not a test: `node scripts/drive.mjs <url> <secret> <name> [name2 ...]`
// Each name gets its own profile with the secret and name pre-seeded, so the page
// lands straight in the Room. Prints each browser's sidebar and chat, then sends one
// message from the first browser and shows what the others received.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
    this.proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--window-size=${this.size}`, `--user-data-dir=${this.dir}`, `--remote-debugging-port=${this.port}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', detached: true });
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`http://127.0.0.1:${this.port}/json/list`); const tabs = await r.json(); if (tabs.length) { this.tab = tabs[0]; break; } } catch {}
      await sleep(100);
    }
    this.ws = new WebSocket(this.tab.webSocketDebuggerUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.id = 0; this.pending = new Map();
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
    await this.cdp('Runtime.enable');
  }
  cdp(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.pending.set(id, r)); }
  async eval(expression) { const r = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; }
  async goto(u) { await this.cdp('Page.navigate', { url: u }); await sleep(800); }
  async seed() {
    await this.goto(new URL('/', url).href);
    await this.eval(`localStorage.setItem('dave.secret', ${JSON.stringify(secret)}); localStorage.setItem('dave.name', ${JSON.stringify(this.name)}); 'ok'`);
    await this.goto(url);
  }
  async screenshot(path, width) {
    // Emulate a phone viewport regardless of the headless window minimum.
    if (width) await this.cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    const r = await this.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  }
  text(sel) { return this.eval(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map(e => e.innerText.replace(/\\s+/g,' ').trim()).join(' | ')`); }
  async say(text) {
    await this.eval(`(() => { const i = document.querySelector('.chat-input input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`);
    await sleep(50);
    await this.eval(`document.querySelector('.chat-input form, form.chat-input').requestSubmit(); 'sent'`);
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
    await sleep(8000); // mesh formation plus stats ticks
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
      await sharer.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share'`);
      await sleep(3000);
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
    }
    if (shotDir) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(shotDir, { recursive: true });
      for (const b of browsers) await b.screenshot(`${shotDir}/${b.name}.png`, narrowLast && b === browsers[browsers.length - 1] ? 390 : undefined);
      console.log(`screenshots in ${shotDir}`);
    }
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
  for (const b of browsers) b.close();
}
