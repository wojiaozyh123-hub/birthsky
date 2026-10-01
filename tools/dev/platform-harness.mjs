// Dev-only test harness for the PLATFORM modules (fonts, ui.js, audio.js, monetize.js).
// Serves src/ plus /node_modules on a throwaway port and launches headless Chromium (SwiftShader).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const outDir = path.join(root, '.cache/dev');
fs.mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };

export async function startServer() {
  const webRoot = path.join(root, 'src');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let f = u.pathname.startsWith('/node_modules/') ? path.join(root, decodeURIComponent(u.pathname)) : path.join(webRoot, decodeURIComponent(u.pathname));
    if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

export async function launch(extraArgs = []) {
  const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  return puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--lang=zh-CN', ...extraArgs],
  });
}

export function watch(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`console.${m.type()}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
