#!/usr/bin/env node
// Drives the real first-visit flow in headless Chromium: invite link with the secret in the fragment,
// the name form typed with keyboard events, then messages typed and sent with Enter. Reports exceptions.
// usage: node scripts/first-visit.mjs <url> <secret> <name>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const [url, secret, name] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'dave-first-'));
const port = Number(process.env.PORT ?? 9890);
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore', detached: true });
let tab; for (let i = 0; i < 50 && !tab; i++) { try { const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); tab = t[0]; } catch {} await sleep(100); }
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const problems = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') problems.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n').slice(0, 4).join(' | '));
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)); };
const cdp = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const type = async (text) => { for (const ch of text) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); } };
const enter = async () => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
await cdp('Runtime.enable');
await cdp('Page.enable');
if (process.env.PATCH_SCROLL) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'Element.prototype.scrollTo = function () { return true; };' }); // simulate a scroll-hooking extension
try {
  await cdp('Page.navigate', { url: `${url}#${encodeURIComponent(secret)}` }); await sleep(1500);
  console.log('step 1 (fragment consumed):', await evaluate('location.hash + " | " + document.body.innerText.replace(/\\s+/g," ").slice(0,80)'));
  await evaluate(`document.querySelector('input')?.focus(); 'focused'`); await type(name); await sleep(200); await enter(); await sleep(2500);
  console.log('step 2 (after name):', await evaluate('document.body.innerText.replace(/\\s+/g," ").slice(0,120)'));
  for (const text of ['first message', 'second message', 'third message']) {
    await evaluate(`document.querySelector('.chat-input input')?.focus(); 'focused'`); await type(text); await sleep(100); await enter(); await sleep(900);
    console.log(`after "${text}":`, await evaluate(`document.querySelectorAll('.chat-log .msg').length + ' lines; input="' + (document.querySelector('.chat-input input')?.value ?? '?') + '"'`));
  }
  // Rapid fire: three sends with no wait between them.
  for (const text of ['rapid 1', 'rapid 2', 'rapid 3']) { await evaluate(`document.querySelector('.chat-input input')?.focus(); 'f'`); await type(text); await enter(); }
  await sleep(1200);
  console.log('after rapid fire:', await evaluate(`document.querySelectorAll('.chat-log .msg').length + ' lines'`));
  // Second tab in the same browser: same identity key attached twice.
  const t2 = await cdp('Target.createTarget', { url });
  await sleep(2500);
  console.log('second tab opened; first tab online list:', await evaluate(`[...document.querySelectorAll('.side ul:nth-of-type(1) li')].map(l => l.innerText.replace(/\s+/g,' ')).join(' | ')`));
  for (const text of ['after second tab 1', 'after second tab 2']) { await evaluate(`document.querySelector('.chat-input input')?.focus(); 'f'`); await type(text); await enter(); await sleep(800); }
  console.log('after second tab messages:', await evaluate(`document.querySelectorAll('.chat-log .msg').length + ' lines'`));
  await cdp('Target.closeTarget', { targetId: t2.result.targetId });
  await sleep(1000);
  for (const text of ['after closing tab']) { await evaluate(`document.querySelector('.chat-input input')?.focus(); 'f'`); await type(text); await enter(); await sleep(800); }
  console.log('after closing second tab:', await evaluate(`document.querySelectorAll('.chat-log .msg').length + ' lines'`));
} finally {
  for (const p of problems) console.log(p);
  if (!problems.length) console.log('no console errors or exceptions');
  try { ws.close(); } catch {}
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 500);
}
