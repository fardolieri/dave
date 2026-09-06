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
const hold = holdArg ? Number(holdArg.slice(7)) : 0;
const [url, secret, ...names] = args.filter((a) => !a.startsWith('--'));
if (!url || !secret || names.length === 0) { console.error('usage: drive.mjs <url> <secret> <name> [name2 ...]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(name, port) { this.name = name; this.port = port; this.dir = mkdtempSync(join(tmpdir(), `dave-${name}-`)); }
  async launch() {
    this.proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${this.dir}`, `--remote-debugging-port=${this.port}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
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
  text(sel) { return this.eval(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map(e => e.innerText.replace(/\\s+/g,' ').trim()).join(' | ')`); }
  async say(text) {
    await this.eval(`(() => { const i = document.querySelector('.chat-input input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`);
    await sleep(50);
    await this.eval(`document.querySelector('.chat-input form, form.chat-input').requestSubmit(); 'sent'`);
  }
  close() { try { this.ws?.close(); } catch {} this.proc?.kill(); rmSync(this.dir, { recursive: true, force: true }); }
}

const portBase = Number(process.env.PORT_BASE ?? 9300);
const browsers = names.map((n, i) => new Browser(n, portBase + i));
try {
  for (const b of browsers) { await b.launch(); await b.seed(); }
  await sleep(1500);
  for (const b of browsers) console.log(`[${b.name}] banner: ${await b.text('.banner') || '(none)'}\n[${b.name}] online: ${await b.text('.plist li')}`);
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
