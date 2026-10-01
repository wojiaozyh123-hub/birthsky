// Loads src/dev/content.html in headless Chromium (serving src/ + /node_modules), checks that the content
// modules run in a real page, and saves a screenshot to .cache/dev/content-*.png.
//   node tools/dev/content-browser.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, '.cache/dev');
fs.mkdirSync(outDir, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = u.pathname.startsWith('/node_modules/') ? path.join(root, decodeURIComponent(u.pathname)) : path.join(root, 'src', decodeURIComponent(u.pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--lang=zh-CN'] });
const errors = [];
let fail = false;
try {
  for (const [w, h] of [[390, 844], [360, 640]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (res) => { if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) errors.push(`http ${res.status()} ${res.url()}`); });
    await page.goto(`${base}dev/content.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ok || window.__err, { timeout: 60000 });
    const r = await page.evaluate(() => ({ ok: !!window.__ok, err: document.getElementById('err').textContent, wrap: window.__wrap, guide: window.__guide, nw: window.__nw }));
    console.log(`${w}×${h}`, JSON.stringify(r, null, 1));
    if (!r.ok) fail = true;
    if (r.wrap && r.wrap.widths.some((x) => x > 700.5)) { console.error('wrapCanvas overflow'); fail = true; }
    if (r.nw && r.nw.some((x) => x.overflow || x.nwFragments.some((n) => n > 1))) { console.error('a no-widow tail broke across lines or a caption overflowed'); fail = true; }
    if (!r.guide || r.guide.length !== 2 || r.guide[0] !== '点右上角 ···') { console.error('share guide lines wrong'); fail = true; }
    await page.screenshot({ path: path.join(outDir, `content-${w}.png`), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error(errors); fail = true; }
console.log(fail ? 'FAILED' : 'browser content check ok');
process.exitCode = fail ? 1 : 0;
