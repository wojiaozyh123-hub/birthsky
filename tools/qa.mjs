// Headless QA: serves src/ (or dist/) on a throwaway port for the duration of the run, drives the
// real app in Chromium at phone size, saves screenshots to .cache/qa/, and fails on page errors.
//   node tools/qa.mjs [scenario ...] [--dist] [--desktop]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useDist = args.includes('--dist');
const desktop = args.includes('--desktop');
const scenarios = args.filter((a) => !a.startsWith('--'));
const webRoot = path.join(root, useDist ? 'dist' : 'src');
const outDir = path.join(root, '.cache/qa');
fs.mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = u.pathname.startsWith('/node_modules/') ? path.join(root, decodeURIComponent(u.pathname)) : path.join(webRoot, decodeURIComponent(u.pathname));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
});

const errors = [];
async function newPage(query = '') {
  const page = await browser.newPage();
  if (desktop) await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  else await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateTimezone('Asia/Shanghai');
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`console.${m.type()}: ${m.text()}`); else if (args.includes('--verbose')) console.log('  [page]', m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.setDefaultTimeout(60000);
  await page.goto(base + query, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}${desktop ? '-desk' : ''}.png`) });
async function tap(page, sel) {
  await page.waitForSelector(sel, { visible: true, timeout: 15000 });
  await page.click(sel);
}
async function waitStart(page) {
  await page.waitForFunction(() => !document.querySelector('#btn-start').disabled, { timeout: 30000 });
  await page.waitForFunction(() => window.__birthsky?.cities?.citiesReady?.(), { timeout: 30000 });
}
async function fillForm(page, { name = '小明', date = '1998-07-14', time = '22:00', city = '杭州' } = {}) {
  await page.waitForSelector('#form.is-open');
  await sleep(900);
  await page.$eval('#f-name', (el, v) => { el.value = v; }, name);
  await page.$eval('#f-date', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, date);
  await page.$eval('#f-time', (el, v) => { el.value = v; }, time);
  await page.click('#f-city', { clickCount: 3 });
  await page.keyboard.type(city);
  await page.waitForSelector('#f-suggest.is-open li[data-i]');
  await sleep(300);
}

function encodePerson({ name = '小明', date = '1998-07-14', time = '22:00', city = '杭州', region = '浙江', lat = 30.29, lon = 120.16, tz = 'Asia/Shanghai' } = {}) {
  const raw = [1, name, date.replace(/-/g, ''), time.replace(':', ''), 0, city, region, lat.toFixed(2), lon.toFixed(2), tz].join('|');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function toSky(page) {
  await waitStart(page);
  await tap(page, '#btn-start');
  await page.waitForFunction(() => window.__birthsky.mode === 'sky' && document.querySelector('#hud.is-active'), { timeout: 90000 });
  await sleep(1500);
}

const S = {
  async wechat() {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.54(0x18003630) NetType/WIFI Language/zh_CN');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.emulateTimezone('Asia/Shanghai');
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.setDefaultTimeout(60000);
    await page.goto(base + `?p=${encodePerson()}`, { waitUntil: 'domcontentloaded' });
    await toSky(page);
    await page.evaluate(() => { window.__birthsky.own = true; document.querySelector('#hud').classList.remove('is-guest'); document.querySelector('#guest-bar').classList.remove('is-active'); });
    await sleep(400);
    await tap(page, '#btn-share');
    await sleep(900);
    await shot(page, 'wx-guide');
    console.log('shared url:', await page.evaluate(() => location.href), '| title:', await page.title());
    await page.click('#share-guide');
    await sleep(600);
    await page.evaluate(() => window.__birthsky.api.openPoster('single'));
    await page.waitForSelector('#poster-img.is-ready', { timeout: 60000 });
    console.log('poster tip:', await page.$eval('#poster-tip', (e) => e.textContent), '| save hidden:', await page.$eval('#btn-save', (e) => e.hidden));
    await page.close();
  },
  async rewind() {
    const page = await newPage(`?p=${encodePerson({ name: '阿星', date: '1995-12-20', time: '23:10', city: '北京', region: '', lat: 39.91, lon: 116.4 })}`);
    await waitStart(page);
    await sleep(500);
    await tap(page, '#btn-start');
    const t0 = Date.now();
    for (const at of [1800, 3400, 5000, 6600, 8200]) {
      await sleep(Math.max(0, at - (Date.now() - t0)));
      await shot(page, `rw-${at}`);
    }
    await sleep(6000);
    await shot(page, 'rw-final');
    await page.close();
  },
  async assets() {
    const page = await newPage();
    await page.waitForFunction(() => window.__birthsky?.posters, { timeout: 60000 });
    const out = await page.evaluate(async () => {
      const app = window.__birthsky;
      await document.fonts.load('500 40px "Cormorant Garamond"');
      await document.fonts.load('italic 400 40px "Cormorant Garamond"');
      const { skyState } = await import('/js/astro.js');
      // Hangzhou, a clear summer night with the Milky Way overhead
      const sky = skyState(new Date('2026-08-08T14:00:00Z'), 30.27, 120.16);
      const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
      const bg = (ctx, w, h) => { const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0c1430'); g.addColorStop(1, '#03050d'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); };
      const res = {};
      // og 1200×630
      { const [c, ctx] = mk(1200, 630); bg(ctx, 1200, 630);
        const d = app.posters.dome(sky, 560, 'night', { labels: false, names: false });
        ctx.drawImage(d, 40, 35);
        ctx.strokeStyle = 'rgba(226,199,150,.55)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(320, 315, 284, 0, 7); ctx.stroke();
        ctx.fillStyle = '#e2c796'; ctx.font = 'italic 400 30px "Cormorant Garamond"'; ctx.fillText('The Night You Arrived', 680, 220);
        ctx.fillStyle = '#f5eedf'; ctx.font = '500 76px "Songti SC", serif'; ctx.fillText('你来的那晚', 676, 320);
        ctx.fillStyle = 'rgba(245,238,223,.7)'; ctx.font = '30px "Songti SC", serif'; ctx.fillText('看看你出生那晚的星空', 680, 390);
        ctx.fillStyle = 'rgba(245,238,223,.45)'; ctx.font = '22px -apple-system, sans-serif'; ctx.fillText('银河 · 月相 · 行星 · 星空合盘', 682, 440);
        res.og = c.toDataURL('image/jpeg', 0.9); }
      // WeChat thumbnail 400×400
      { const [c, ctx] = mk(400, 400); bg(ctx, 400, 400);
        const d = app.posters.dome(sky, 360, 'night', { labels: false, names: false }); ctx.drawImage(d, 20, 20);
        res.thumb = c.toDataURL('image/jpeg', 0.9); }
      // icons from the svg
      const img = new Image(); img.src = '/assets/icon.svg'; await img.decode();
      for (const size of [180, 512]) { const [c, ctx] = mk(size, size); ctx.drawImage(img, 0, 0, size, size); res['icon' + size] = c.toDataURL('image/png'); }
      return res;
    });
    const w = (name, data) => fs.writeFileSync(path.join(root, 'src/assets', name), Buffer.from(data.split(',')[1], 'base64'));
    w('og.jpg', out.og); w('share-thumb.jpg', out.thumb); w('icon-180.png', out.icon180); w('icon-512.png', out.icon512);
    await page.close();
  },
  async poster() {
    const page = await newPage(`?p=${encodePerson()}`);
    await toSky(page);
    await shot(page, 'p-sky');
    const t = Date.now();
    const err = await page.evaluate(async () => {
      try {
        const app = window.__birthsky;
        const c = await app.posters.single({ person: app.viewing, sky: app.sky, facts: app.facts, style: 'night', texts: { title: 'test', line: 'line' }, url: location.href });
        return 'ok ' + c.width;
      } catch (e) { return 'ERR ' + e.message + '\n' + e.stack; }
    });
    console.log('poster direct:', err, `${Date.now() - t}ms`);
    await page.evaluate(() => window.__birthsky.api.openPoster('single'));
    await page.waitForSelector('#poster-img.is-ready', { timeout: 60000 });
    await shot(page, 'poster-modal');
    await savePoster(page, 'poster-night');
    for (const style of ['paper', 'ink', 'dusk']) {
      await page.click(`[data-style="${style}"]`);
      await sleep(300);
      await page.waitForSelector('#poster-img.is-ready', { timeout: 60000 });
      await savePoster(page, `poster-${style}`);
    }
    await page.close();
  },
  async intro() {
    const page = await newPage();
    await sleep(6500);
    await shot(page, 'intro');
    await page.close();
  },
  async flow() {
    const page = await newPage();
    await waitStart(page);
    await sleep(1500);
    await tap(page, '#btn-start');
    await sleep(2800);
    await fillForm(page);
    await shot(page, 'form');
    await page.keyboard.press('Enter');
    await tap(page, '#btn-go');
    await sleep(3200);
    await shot(page, 'rewind');
    await sleep(4400);
    await shot(page, 'arrival');
    await sleep(5200);
    await shot(page, 'sky');
    await tap(page, '#facts-handle');
    await sleep(1000);
    await shot(page, 'facts');
    await tap(page, '#facts-handle');
    await sleep(900);
    // tap the brightest named star above the horizon
    const pt = await page.evaluate(() => {
      const app = window.__birthsky;
      const pos = app.catalog.stars.pos;
      for (const [i] of app.catalog.names) {
        const v = [0, 1, 2].map((k) => app.sky.M[k] * pos[i * 3] + app.sky.M[k + 3] * pos[i * 3 + 1] + app.sky.M[k + 6] * pos[i * 3 + 2]);
        if (v[2] > 0.3) { const p = app.cam.project(v, {}); return p; }
      }
      return null;
    });
    if (pt) await page.mouse.click(pt.x, pt.y);
    await sleep(900);
    await shot(page, 'star-card');
    await tap(page, '#btn-listen');
    await sleep(6000);
    await shot(page, 'listen');
    await tap(page, '#btn-listen');
    await tap(page, '#btn-poster');
    await page.waitForSelector('#poster-img.is-ready', { timeout: 30000 });
    await sleep(600);
    await shot(page, 'poster-modal');
    await savePoster(page, 'poster-night');
    for (const style of ['paper', 'ink', 'dusk']) {
      await page.click(`[data-style="${style}"]`);
      await sleep(300);
      await page.waitForSelector('#poster-img.is-ready', { timeout: 30000 });
      await savePoster(page, `poster-${style}`);
    }
    await page.click('#poster [data-close]');
    await sleep(800);
    await tap(page, '#btn-hepan');
    await sleep(900);
    await shot(page, 'hepan-invite');
    await tap(page, '#btn-manual');
    await sleep(1200);
    await fillForm(page, { name: '小红', date: '2000-02-03', time: '06:30', city: '成都' });
    await page.keyboard.press('Enter');
    await tap(page, '#btn-go');
    await sleep(3500);
    await shot(page, 'hepan');
    await page.evaluate(() => { document.querySelector('#hepan').scrollTop = 600; });
    await sleep(500);
    await shot(page, 'hepan-2');
    await tap(page, '#hp-poster');
    await page.waitForSelector('#poster-img.is-ready', { timeout: 30000 });
    await savePoster(page, 'poster-hepan');
    const links = await page.evaluate(() => location.href);
    console.log('result link:', links);
    fs.writeFileSync(path.join(outDir, 'last-result-link.txt'), links);
    await page.close();
  },
  async guest() {
    const link = fs.readFileSync(path.join(outDir, 'last-result-link.txt'), 'utf8');
    const u = new URL(link);
    const page = await newPage(`?p=${u.searchParams.get('h')}`);
    await waitStart(page);
    await sleep(800);
    await shot(page, 'guest-intro');
    await tap(page, '#btn-start');
    await sleep(12500);
    await shot(page, 'guest-sky');
    await page.close();
    const p2 = await newPage(`?h=${u.searchParams.get('h')}&b=${u.searchParams.get('b')}`);
    await waitStart(p2);
    await tap(p2, '#btn-start');
    await sleep(4000);
    await shot(p2, 'result-link');
    await p2.close();
  },
  async horizon() {
    const page = await newPage();
    await waitStart(page);
    await tap(page, '#btn-start');
    await sleep(2500);
    await fillForm(page, { date: '2001-08-20', time: '21:30', city: '丽江' });
    await page.keyboard.press('Enter');
    await tap(page, '#btn-go');
    await sleep(13500);
    await tap(page, '#btn-view');
    await sleep(2600);
    await shot(page, 'horizon');
    await tap(page, '#btn-culture');
    await tap(page, '#btn-view');
    await sleep(2600);
    await shot(page, 'xingguan');
    await page.close();
  },
};

async function savePoster(page, name) {
  const data = await page.evaluate(() => window.__birthsky.posterCanvas.toDataURL('image/jpeg', 0.9));
  fs.writeFileSync(path.join(outDir, `${name}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
}

try {
  for (const s of scenarios.length ? scenarios : ['intro', 'flow']) {
    const t = Date.now();
    await S[s]();
    console.log(`✓ ${s} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
} catch (e) {
  console.log('✗', e.message);
  errors.push(`qa: ${e.message}`);
} finally {
  await browser.close();
  server.close();
}
const uniq = [...new Set(errors)];
if (uniq.length) { console.log(`\n${uniq.length} problem(s):`); uniq.slice(0, 40).forEach((e) => console.log(' -', e)); process.exitCode = 1; }
else console.log('no page errors');
