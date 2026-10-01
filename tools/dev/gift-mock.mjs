// Renders 星空贺卡 mockups to .cache/design-review/ through src/dev/gift.html.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import puppeteer from 'puppeteer-core';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = path.join(root, '.cache/design-review'); fs.mkdirSync(out, { recursive: true });
const T = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const srv = http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); let f = u.pathname.startsWith('/node_modules/') ? path.join(root, u.pathname) : path.join(root, 'src', u.pathname); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.writeHead(404).end(); r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const b = await puppeteer.launch({ executablePath: path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); p.setDefaultTimeout(120000);
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`http://127.0.0.1:${srv.address().port}/dev/gift.html`);
await p.waitForFunction(() => window.giftReady);
const cases = [
  ['gift-night-poem', { message: 'poem' }],
  ['gift-night-own', { message: '二十六岁生日快乐。愿你常常抬头，也常常被星光照见。', greeting: '' }],
  ['gift-mono-poem', { style: 'mono', message: 'poem', step: 2 }],
  ['gift-paper-poem', { style: 'paper', message: 'poem', step: 1, greeting: '' }],
];
for (const [name, cfg] of cases) {
  const url = await p.evaluate((c) => window.renderGift(c), cfg);
  fs.writeFileSync(path.join(out, `${name}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  console.log('ok', name);
}
await b.close(); srv.close();
