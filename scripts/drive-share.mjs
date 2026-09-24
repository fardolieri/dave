#!/usr/bin/env node
// Drives three headless Chromium profiles through the share flows that broke on production (Sep 2026):
//   Bug 2: a presence change (someone leaves, joins or mutes) recreated every share tile, ending a viewer's fullscreen.
//   Bug 1: a Watch click while the room socket was down was dropped for good; the tile promised a picture nobody was asked for.
// Development aid, not a test: `CHROME=/usr/bin/google-chrome node scripts/drive-share.mjs <url> <secret>`
// Expect: Vic's tile stays the same DOM node and fullscreen through Tom's leave, join and mute; Vic's and Tom's Watch clicks
// during a socket drop leave the tile at "Click to watch" and are re-asserted on reconnect (the sharer's subscribedToMe turns true).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const [url, secret] = process.argv.slice(2);
if (!url || !secret) { console.error('usage: drive-share.mjs <url> <secret>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * (Number(process.env.SLOW) || 1))); // SLOW=4 stretches every wait, for a 1 GB VM

class Browser {
  constructor(name, port) { this.name = name; this.port = port; this.dir = mkdtempSync(join(tmpdir(), `dave-${name}-`)); }
  async launch() {
    this.proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--window-size=1200,800', `--user-data-dir=${this.dir}`, `--remote-debugging-port=${this.port}`,
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', detached: true });
    for (let i = 0; i < 1200 && !this.tab; i++) {
      try { const r = await fetch(`http://127.0.0.1:${this.port}/json/list`); this.tab = (await r.json()).find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension:')); } catch {}
      if (!this.tab) await sleep(100);
    }
    if (!this.tab) throw new Error(`${this.name}: no debugging port`);
    this.ws = new WebSocket(this.tab.webSocketDebuggerUrl);
    await new Promise((r) => (this.ws.onopen = r));
    this.id = 0; this.pending = new Map();
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
  }
  cdp(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.pending.set(id, r)); }
  async eval(expression, userGesture = false) { const r = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; }
  gesture(expression) { return this.eval(expression, true); }
  async goto(u) { await this.cdp('Page.navigate', { url: u }); await sleep(800); }
  async seed() {
    await this.goto(new URL('/', url).href);
    const rooms = JSON.stringify([{ secret, name: 'Drive', addedAt: Date.now() }]);
    await this.eval(`localStorage.setItem('dave.rooms', ${JSON.stringify(rooms)}); localStorage.setItem('dave.name', ${JSON.stringify(this.name)}); localStorage.setItem('dave.test', 'true'); 'ok'`);
    await this.goto(url);
  }
  text(sel) { return this.eval(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map(e => e.innerText.replace(/\\s+/g,' ').trim()).join(' | ')`); }
  close() { try { process.kill(-this.proc.pid); } catch {} try { this.proc.kill(); } catch {} setTimeout(() => { try { rmSync(this.dir, { recursive: true, force: true }); } catch {} }, 500); }
}

const log = (b, msg) => console.log(`[${b.name}] ${msg}`);
const [sam, vic, tom] = [new Browser('Sam', Number(process.env.PORT_BASE ?? 9400)), new Browser('Vic', Number(process.env.PORT_BASE ?? 9400) + 1), new Browser('Tom', Number(process.env.PORT_BASE ?? 9400) + 2)];
const all = [sam, vic, tom];
const tileOf = (name) => `[...document.querySelectorAll('.share')].find(t => t.textContent.includes(${JSON.stringify(name)}))`;
// What Vic's tile for Sam looks like: state class, whether it is the same DOM node as before (data-mark), fullscreen, call-layer flags.
const probe = async (b = vic) => JSON.stringify(await b.eval(`(() => { const t = ${tileOf('Sam')}; const v = t?.querySelector('video'); const p = window.__dave?.peers().find(p => p.name === 'Sam');
  return { tile: t ? [...t.classList].filter(c => c.startsWith('share-')).join(' ') : null, sameNode: t?.dataset.mark === 'original', fullscreen: document.fullscreenElement !== null,
    videoFrames: v?.dataset.frames ?? null, watching: p?.watching, shareLive: p?.shareLive, note: t?.querySelector('.share-note')?.textContent ?? null }; })()`));

try {
  for (const b of all) { await b.launch(); await b.seed(); }
  await sleep(1500);
  for (const b of all) { await b.eval(`document.querySelector('button.join')?.click(); 'clicked'`); await sleep(400); }
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(1000);
    const ok = await Promise.all(all.map((b) => b.eval(`[...document.querySelectorAll('.room.selected ul .conn')].map(c => c.textContent.trim()).filter(x => x === 'direct' || x === 'via relay').length`)));
    if (ok.every((n) => n === 2)) break;
  }
  for (const b of all) log(b, `call: ${await b.text('.room.selected ul li')}`);

  await sam.eval(`[...document.querySelectorAll('.actions button')].find(b => b.textContent === 'Share screen')?.click(); 'share'`);
  await sleep(3000);
  log(vic, `tiles: ${await vic.text('.share')}`);
  await vic.gesture(`${tileOf('Sam')}?.click(); 'watch'`);
  await sleep(3000);
  await vic.eval(`${tileOf('Sam')}.dataset.mark = 'original'; 'marked'`);
  log(vic, `watching Sam: ${await probe()}`);

  console.log('\n=== Bug 2: Tom leaves and rejoins while Vic is fullscreen on Sam ===');
  await vic.gesture(`${tileOf('Sam')}?.click(); 'fullscreen'`); await sleep(800);
  log(vic, `entered fullscreen: ${await probe()}`);
  await tom.eval(`document.querySelector('button.leave')?.click(); 'leave'`); await sleep(1500);
  log(vic, `after Tom LEFT the call: ${await probe()}`);
  if (!(await vic.eval('document.fullscreenElement !== null'))) { await vic.gesture(`${tileOf('Sam')}?.click(); 'fullscreen again'`); await sleep(800); }
  await vic.eval(`${tileOf('Sam')}.dataset.mark = 'original'; 'marked'`);
  log(vic, `fullscreen again: ${await probe()}`);
  await tom.eval(`document.querySelector('button.join')?.click(); 'join'`); await sleep(2500);
  log(vic, `after Tom JOINED the call: ${await probe()}`);
  if (!(await vic.eval('document.fullscreenElement !== null'))) { await vic.gesture(`${tileOf('Sam')}?.click(); 'fullscreen again'`); await sleep(800); }
  await vic.eval(`${tileOf('Sam')}.dataset.mark = 'original'; 'marked'`);
  log(vic, `fullscreen again: ${await probe()}`);
  await tom.eval(`[...document.querySelectorAll('.actions button')].find(b => /^(Mute|Unmute)$/.test(b.textContent))?.click(); 'mute'`); await sleep(1500);
  log(vic, `after Tom toggled MUTE: ${await probe()}`);
  if (await vic.eval('document.fullscreenElement !== null')) await vic.gesture(`document.exitFullscreen(); 'exit'`);
  await sleep(500);

  console.log('\n=== Bug 1: Vic clicks Watch while the room socket is down ===');
  await vic.eval(`${tileOf('Sam')}?.querySelector('button.stop')?.click(); 'stop watching'`); await sleep(1000);
  log(vic, `stopped watching: ${await probe()}`);
  // Wait until the receiver track has gone mute (shareLive false), as for a viewer who never had the picture.
  const t1 = Date.now();
  while (Date.now() - t1 < 6000 && await vic.eval(`window.__dave?.peers().find(p => p.name === 'Sam')?.shareLive`)) await sleep(500);
  log(vic, `track idle after ${((Date.now() - t1) / 1000).toFixed(1)} s: ${await probe()}`);
  log(sam, `Sam's view of Vic: ${JSON.stringify(await sam.eval(`window.__dave?.peers().find(p => p.name === 'Vic')`))}`);
  await vic.gesture(`window.__dave.dropSocket(); ${tileOf('Sam')}?.click(); 'drop + watch'`);
  await sleep(300);
  log(vic, `right after the click: ${await probe()} | banner: ${await vic.text('.banner') || '(none)'}`);
  log(sam, `Sam's view of Vic right after: ${JSON.stringify(await sam.eval(`window.__dave?.peers().find(p => p.name === 'Vic')?.subscribedToMe`))}`);
  await sleep(12000);
  log(vic, `12 s later: ${await probe()} | banner: ${await vic.text('.banner') || '(none)'} | socket: ${await vic.eval(`window.__dave?.state().inCall`)}`);
  log(sam, `Sam's view of Vic: ${JSON.stringify(await sam.eval(`window.__dave?.peers().find(p => p.name === 'Vic')`))}`);
  log(sam, `Sam's outgoing: ${JSON.stringify(await sam.eval(`window.__dave?.share().outgoing`))}`);

  console.log('\n=== Bug 1b: Tom (fresh connection after his rejoin, never saw the picture) clicks Watch while his socket is down ===');
  log(tom, `before: ${await probe(tom)}`);
  await tom.gesture(`window.__dave.dropSocket(); ${tileOf('Sam')}?.click(); 'drop + watch'`);
  await sleep(300);
  log(tom, `right after the click: ${await probe(tom)} | banner: ${await tom.text('.banner') || '(none)'}`);
  log(sam, `Sam's view of Tom right after: ${JSON.stringify(await sam.eval(`window.__dave?.peers().find(p => p.name === 'Tom')?.subscribedToMe`))}`);
  await sleep(15000);
  log(tom, `15 s later: ${await probe(tom)} | banner: ${await tom.text('.banner') || '(none)'} | inCall: ${await tom.eval(`window.__dave?.state().inCall`)}`);
  log(sam, `Sam's view of Tom: ${JSON.stringify(await sam.eval(`window.__dave?.peers().find(p => p.name === 'Tom')`))}`);
  log(sam, `Sam's outgoing: ${JSON.stringify(await sam.eval(`window.__dave?.share().outgoing`))}`);
  // Control: stop watching, then the same Watch click with the socket up.
  await tom.eval(`${tileOf('Sam')}?.querySelector('button.stop')?.click(); 'stop watching'`); await sleep(1000);
  await tom.gesture(`${tileOf('Sam')}?.click(); 'watch'`); await sleep(4000);
  log(tom, `control, after unwatch + watch with the socket up: ${await probe(tom)}`);
  log(sam, `Sam's view of Tom: ${JSON.stringify(await sam.eval(`window.__dave?.peers().find(p => p.name === 'Tom')?.subscribedToMe`))}`);
} finally {
  for (const b of all) b.close();
}
