// OVERLAY dev tests: a throwaway static server for src/ (+ /node_modules for the import map) and a headless
// Chromium with SwiftShader WebGL (pattern of tools/qa.mjs), with GC and precise heap numbers for the
// allocation probe.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };

export async function start({ width = 390, height = 844 } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const base = u.pathname.startsWith('/node_modules/') ? root : path.join(root, 'src');
    let f = path.join(base, decodeURIComponent(u.pathname));
    if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--lang=zh-CN',
      '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const errors = [];
  async function open(pagePath) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.emulateTimezone('Asia/Shanghai');
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Failed to load resource/.test(m.text())) return;
      if (['error', 'warning'].includes(m.type())) errors.push(`console.${m.type()}: ${m.text()}`);
    });
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`http ${r.status()}: ${r.url()}`); });
    page.setDefaultTimeout(240000);
    await page.goto(base + pagePath, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.overlayReady, { timeout: 120000 }).catch((e) => { console.log(errors.join('\n')); throw e; });
    return page;
  }
  async function close() { await browser.close(); server.close(); }
  return { base, browser, open, close, errors };
}
