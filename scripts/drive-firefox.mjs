#!/usr/bin/env node
// Viewer check in Firefox (or Playwright's Chromium): the sharer runs in headless Chromium, the viewer joins, clicks the share
// tile with a trusted click, and the video element is probed (paused, presented frames, mean brightness of what it paints),
// then fullscreen, Stop watching and re-watch are exercised. Development aid like drive.mjs, which cannot drive Firefox (no CDP).
// Needs Playwright with its Firefox build, installed anywhere: npm i playwright && npx playwright install firefox, then
//   PLAYWRIGHT=<that dir>/node_modules/playwright node scripts/drive-firefox.mjs <url> <secret> firefox [autoplay-block]
// autoplay-block starts Firefox with media.autoplay.default=5 and blocking_policy=2 (nothing plays without a fresh gesture),
// or Chromium with --autoplay-policy=user-gesture-required. The sharer uses the Chromium drive.mjs uses (CHROME, same default).
import { pathToFileURL } from 'node:url';
const { chromium, firefox } = await import(process.env.PLAYWRIGHT ? pathToFileURL(process.env.PLAYWRIGHT.replace(/\/?$/, '/index.mjs')).href : 'playwright');

const [url, secret, engine, mode] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = async (page, name) => {
  await page.goto(url); await page.evaluate(({ secret, name }) => { localStorage.setItem('dave.secret', secret); localStorage.setItem('dave.name', name); localStorage.setItem('dave.test', 'true'); }, { secret, name });
  await page.goto(url); await page.waitForSelector('button.join', { timeout: 15000 });
};
const warnings = [];
const executablePath = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome`;
const sharerBrowser = await chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const sharer = await sharerBrowser.newPage();
const block = mode === 'autoplay-block';
const viewerBrowser = engine === 'firefox'
  ? await firefox.launch({ firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, ...(block ? { 'media.autoplay.default': 5, 'media.autoplay.blocking_policy': 2 } : {}) } })
  : await chromium.launch({ executablePath, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(block ? ['--autoplay-policy=user-gesture-required'] : [])] });
const viewer = await viewerBrowser.newPage();
viewer.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text().slice(0, 120)); });
viewer.on('pageerror', (e) => warnings.push('PAGEERROR ' + e.message));
try {
  await seed(sharer, 'Alice'); await seed(viewer, 'Vera');
  await sharer.click('button.join'); await viewer.click('button.join');
  await sleep(2500);
  console.log(`[Vera/${engine}${block ? '/autoplay-block' : ''}] call list: ${await viewer.locator('.side ul:nth-of-type(2) li').allInnerTexts().then((t) => t.join(' | '))}`);
  await sharer.click('.actions button:has-text("Share screen")'); await sleep(2500);
  console.log(`[Vera] tile before click: ${(await viewer.locator('.share').allInnerTexts()).join(' | ').replace(/\s+/g, ' ')}`);
  await viewer.click('.share'); // a trusted click: the user gesture
  const probe = () => viewer.evaluate(() => { const v = document.querySelector('.share video'); if (!v) return null; const q = v.getVideoPlaybackQuality?.(); let brightness = null;
    try { const c = document.createElement('canvas'); c.width = 32; c.height = 32; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 32, 32); const d = g.getImageData(0, 0, 32, 32).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; brightness = Math.round(s / (d.length / 4) / 3); } catch (e) { brightness = 'error: ' + e.message; }
    return { tile: document.querySelector('.share').className.trim(), paused: v.paused, hidden: v.hidden, width: v.videoWidth, frames: q?.totalVideoFrames ?? null, shown: v.dataset.frames ?? null, brightness, note: document.querySelector('.share .share-note')?.textContent ?? null }; });
  let at = 0; for (const t of [1000, 3000, 6000, 10000]) { await sleep(t - at); at = t; console.log(`[Vera] t+${t / 1000}s video element: ${JSON.stringify(await probe())}`); }
  console.log(`[Vera] tile now: ${(await viewer.locator('.share').allInnerTexts()).join(' | ').replace(/\s+/g, ' ')}`);
  // Fullscreen on the running tile, then back, then Stop watching (spec §6.5) must still behave.
  await viewer.click('.share'); await sleep(800);
  console.log(`[Vera] after clicking the running tile: fullscreen=${await viewer.evaluate(() => document.fullscreenElement?.className.split(' ')[0] ?? null)}`);
  await viewer.click('.share'); await sleep(500);
  console.log(`[Vera] after clicking again: fullscreen=${await viewer.evaluate(() => document.fullscreenElement !== null)} | ${JSON.stringify(await probe())}`);
  await viewer.click('.share .stop'); await sleep(800);
  console.log(`[Vera] after Stop watching: ${(await viewer.locator('.share').allInnerTexts()).join(' | ').replace(/\s+/g, ' ')}`);
  await viewer.click('.share'); await sleep(4000);
  console.log(`[Vera] watching again: ${JSON.stringify(await probe())}`);
  await sharer.click('.actions button:has-text("Stop sharing")'); await sleep(1200);
  console.log(`[Vera] after sharer stopped: tiles=${(await viewer.locator('.share').count())}`);
} finally {
  for (const w of new Set(warnings)) console.log(`[Vera] console: ${w}`);
  await viewer.click('button.leave').catch(() => {}); await sharer.click('button.leave').catch(() => {}); await sleep(500);
  await viewerBrowser.close(); await sharerBrowser.close();
}
