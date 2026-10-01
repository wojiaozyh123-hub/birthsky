// EXPORT dev: decode the QR of saved exports from crops at several scales / qualities (diagnostics).
//   node tools/dev/export-qrdebug.mjs name ...
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>qr</title>'); return; }
  const f = u.pathname.startsWith('/node_modules/') ? path.join(root, u.pathname) : path.join(root, '.cache/export', u.pathname);
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.jpg') ? 'image/jpeg' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new' });
const page = await browser.newPage();
await page.goto(base + 'blank.html');
await page.addScriptTag({ url: base + 'node_modules/jsqr/dist/jsQR.js' });
for (const name of process.argv.slice(2)) {
  const r = await page.evaluate(async (src) => {
    const load = (s) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = s; });
    const img = await load(src);
    const out = [];
    for (const [label, box] of [['whole', [0, 0, img.width, img.height]], ['qr-crop', [img.width - 320, img.height - 320, 320, 320]]]) {
      for (const scale of [1, 0.75, 0.5]) {
        for (const q of [0.92, 0.8]) {
          const c = document.createElement('canvas');
          c.width = Math.round(box[2] * scale); c.height = Math.round(box[3] * scale);
          const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
          x.drawImage(img, box[0], box[1], box[2], box[3], 0, 0, c.width, c.height);
          const i2 = await load(c.toDataURL('image/jpeg', q));
          const c2 = document.createElement('canvas'); c2.width = i2.width; c2.height = i2.height;
          const x2 = c2.getContext('2d'); x2.drawImage(i2, 0, 0);
          const d = x2.getImageData(0, 0, c2.width, c2.height);
          const code = window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
          out.push(`${label} ${scale} q${q}: ${code ? 'OK ' + code.data.length + ' chars' : '-'}`);
        }
      }
    }
    return out;
  }, base + name + '.jpg');
  console.log(name + '\n  ' + r.join('\n  '));
}
await browser.close(); server.close();
