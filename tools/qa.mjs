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
// --label=NAME sends every screenshot of the run to .cache/render/NAME/ (for before/after comparisons)
const label = args.find((a) => a.startsWith('--label='))?.slice(8);
const outDir = path.join(root, label ? `.cache/render/${label}` : '.cache/qa');
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
async function newPage(query = '', { dsf = 2 } = {}) {
  const page = await browser.newPage();
  if (desktop) await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  else await page.setViewport({ width: 390, height: 844, deviceScaleFactor: dsf, isMobile: true, hasTouch: true });
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
  await page.waitForFunction(() => !document.querySelector('#btn-start').disabled, { timeout: 90000 });
  await page.waitForFunction(() => window.__birthsky?.cities?.citiesReady?.(), { timeout: 90000 });
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
  // Rendering check: the bare sky (no DOM UI) in three full-bleed framings at 390×844 @3x, a poster,
  // and a 1290×2796 first-person phone wallpaper rendered by a second SkyRenderer.
  async render() {
    const page = await newPage(`?p=${encodePerson({ date: '1998-07-14', time: '22:00', city: '杭州', lat: 30.29, lon: 120.16 })}`, { dsf: 3 });
    await toSky(page);
    await page.evaluate(() => window.__birthsky.catalog.deepReady);
    await sleep(2500); // let the arrival tweens (labels, names, crisp) and the deep-star fade settle
    const info = await page.evaluate(async () => {
      const app = window.__birthsky;
      document.querySelector('#app').style.display = 'none';
      document.querySelector('#btn-about').style.display = 'none';
      // screenshots may nudge the viewport; don't let layout() snap the camera back to a preset
      window.addEventListener('resize', (e) => e.stopImmediatePropagation(), true);
      const { radec, mul, DEG } = await import('/js/astro.js');
      const { mwAt } = await import('/js/catalog.js');
      const M = app.sky.M;
      const toAltAz = (n) => ({ alt: Math.asin(n[2]) / DEG, az: ((Math.atan2(n[1], n[0]) / DEG) + 360) % 360 });
      const gc = toAltAz(mul(M, radec(266.405, -28.936)));
      let face = gc;
      if (gc.alt < 8) {
        // brightest Milky Way direction above the horizon
        const Mt = [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
        let best = -1;
        for (let az = 0; az < 360; az += 5) {
          for (let alt = 15; alt <= 70; alt += 5) {
            const n = [Math.cos(alt * DEG) * Math.cos(az * DEG), Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG)];
            const e = mul(Mt, n);
            const L = mwAt(app.catalog.mwLum, Math.atan2(e[1], e[0]) / DEG, Math.asin(e[2]) / DEG);
            if (L > best) { best = L; face = { alt, az }; }
          }
        }
      }
      Object.assign(app.vis, { lines: 0, labels: 0, names: 0, ring: 0, bodyLabels: 0, terrainH: 0.05 });
      app.camPreset = 'free';
      window.__renderFace = face;
      return { gc, face, dpr: app.dpr, stars: app.catalog.stars.count, dust: app.catalog.dust.count,
        deep: app.catalog.deep?.count ?? 0, canvas: [app.renderer.canvas.width, app.renderer.canvas.height] };
    });
    console.log('render:', JSON.stringify(info));
    const views = [
      ['a-firstperson', (f) => ({ alt: 35, az: f.az, domeR: 900, cx: 195, cy: 380, zoom: 1 })],
      ['b-zenith', () => ({ alt: 90, az: 180, domeR: 1400, cx: 195, cy: 422, zoom: 1 })],
      ['c-zoom3', (f) => ({ alt: Math.max(12, f.alt + 3), az: f.az, domeR: 900, cx: 195, cy: 380, zoom: 3 })],
    ];
    await sleep(800); // hiding the UI can trigger a resize → layout() → camera preset; let that pass first
    const setCam = (c) => page.evaluate((c) => {
      const app = window.__birthsky;
      Object.assign(app.cam, c);
      app.vel.az = app.vel.alt = 0;
      Object.assign(app.vis, { lines: 0, labels: 0, names: 0, ring: 0, bodyLabels: 0, terrainH: 0.05 });
    }, c);
    for (const [name, fn] of views) {
      await setCam(fn(info.face));
      await sleep(1200);
      await setCam(fn(info.face));
      await sleep(1200);
      await page.screenshot({ path: path.join(outDir, `${name}.png`), captureBeyondViewport: false });
    }
    // the small whole-sky chart still used by some screens: density must stay clean, not grey
    await setCam({ alt: 90, az: 180, domeR: 170, cx: 195, cy: 400, zoom: 1 });
    await sleep(1200);
    await setCam({ alt: 90, az: 180, domeR: 170, cx: 195, cy: 400, zoom: 1 });
    await sleep(1200);
    await page.screenshot({ path: path.join(outDir, 'f-dome-small.png'), captureBeyondViewport: false });
    // star trails: replay main.js's rewind step at a steady 60 fps through the fastest part of the
    // spin, offscreen at 390×844 @3x — full-bleed overhead, and the small chart the rewind used to use
    const simTrails = (camCfg, dome) => page.evaluate(async (camCfg, dome) => {
      const app = window.__birthsky;
      const { SkyRenderer } = await import('/js/renderer.js');
      const { Camera, ease } = await import('/js/camera.js');
      const { skyMatrix, skyState, SIDEREAL_DAY_MS } = await import('/js/astro.js');
      const canvas = document.createElement('canvas');
      const r = new SkyRenderer(canvas, app.catalog, { preserve: true });
      r.resize(390, 844, 3);
      const cam = new Camera();
      Object.assign(cam, camCfg);
      cam.update();
      const REWIND_MS = 6200, lat = app.lat, lon = app.lon, target = app.birth.getTime();
      const D = 4 * SIDEREAL_DAY_MS + 0.37 * SIDEREAL_DAY_MS;
      const trail = { on: true, fade: 0.95, opacity: 1, Ms: [], clear: true, gain: 0.24 };
      let lastT = null, last = null;
      const frames = 48, dt = 1 / 60;
      for (let f = 0; f <= frames; f++) {
        const s = 0.38 + f * dt * 1000 / REWIND_MS;
        const T = target + (1 - ease.inOut(s)) * D;
        const prevT = lastT ?? T;
        const spinDeg = Math.abs(prevT - T) / SIDEREAL_DAY_MS * 360;
        const n = Math.max(1, Math.min(18, Math.ceil(spinDeg / 0.6)));
        const Ms = [];
        for (let i = 1; i <= n; i++) Ms.push(skyMatrix(new Date(prevT + (T - prevT) * (i / n)), lat, lon));
        lastT = T;
        Object.assign(trail, { Ms, clear: f === 0, fade: Math.exp(-dt / 0.6), gain: 0.24 * Math.min(1, spinDeg / n / 0.6) });
        last = skyState(new Date(T), lat, lon);
        r.render({
          cam, M: last.M, time: f * dt, sun: last.sun.n, moon: last.moon.n, moonIllum: 0, twilight: 0, day: 0,
          reveal: 6.6, mwAmt: 1, starGain: 1, dustGain: 1, sizeGain: 1, crisp: 0.18, flash: 0, sweep: 0, sweepOn: 0,
          sel: -1, twinkle: 0, terrainH: 0.028, bg: [4 / 255, 6 / 255, 13 / 255], dome, exposure: 1, grain: 0.014, vignette: 0.55, trail,
        });
      }
      const url = canvas.toDataURL('image/jpeg', 0.92);
      if (r.dispose) r.dispose(); else r.gl.getExtension('WEBGL_lose_context')?.loseContext();
      return url;
    }, camCfg, dome);
    const tr = Date.now();
    const trailsFull = await simTrails({ alt: 90, az: 180, domeR: 1400, cx: 195, cy: 422, zoom: 1 }, 1);
    fs.writeFileSync(path.join(outDir, 'g-trails-60fps.jpg'), Buffer.from(trailsFull.split(',')[1], 'base64'));
    const trailsDome = await simTrails({ alt: 90, az: 180, domeR: 170, cx: 195, cy: 400, zoom: 1 }, 1);
    fs.writeFileSync(path.join(outDir, 'h-trails-dome-60fps.jpg'), Buffer.from(trailsDome.split(',')[1], 'base64'));
    console.log(`trails ${Date.now() - tr}ms`);
    // phone wallpaper: first person, looking up, rendered offscreen at 1290×2796
    const t = Date.now();
    const wp = await page.evaluate(async (face) => {
      const app = window.__birthsky;
      const { SkyRenderer } = await import('/js/renderer.js');
      const { Camera } = await import('/js/camera.js');
      const W = 1290, H = 2796;
      const canvas = document.createElement('canvas');
      const r = new SkyRenderer(canvas, app.catalog, { preserve: true });
      r.resize(W, H, 1);
      const cam = new Camera();
      Object.assign(cam, { alt: 48, az: face.az, domeR: 900 * W / 390, cx: W / 2, cy: H * 0.44, zoom: 1 });
      cam.update();
      const sky = app.sky;
      const sm = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
      r.render({
        cam, M: sky.M, time: 0, sun: sky.sun.n, moon: sky.moon.n, moonIllum: sky.moonPhase.illum * (sky.moon.alt > -2 ? 1 : 0),
        twilight: sm(-18, -2, sky.sun.alt) * 0.92, day: sm(-3, 10, sky.sun.alt) * 0.6,
        reveal: 6.6, mwAmt: 1, starGain: 1, dustGain: 1, sizeGain: W / 430, crisp: 1, flash: 0, sweep: 0, sweepOn: 0,
        sel: -1, twinkle: 0, terrainH: 0.05, bg: [4 / 255, 6 / 255, 13 / 255], dome: 0, exposure: 1, grain: 0.014, vignette: 0.55, trail: null,
      });
      const url = canvas.toDataURL('image/jpeg', 0.92);
      r.gl.getExtension('WEBGL_lose_context')?.loseContext();
      return url;
    }, info.face);
    fs.writeFileSync(path.join(outDir, 'd-wallpaper.jpg'), Buffer.from(wp.split(',')[1], 'base64'));
    console.log(`wallpaper ${Date.now() - t}ms`);
    const pt = Date.now();
    const poster = await page.evaluate(async () => {
      const app = window.__birthsky;
      const c = await app.posters.single({ person: app.viewing, sky: app.sky, facts: app.facts, style: 'night', texts: { title: '小明出生那晚的星空', line: '那一刻，4,267 颗星星在头顶亮着' }, url: location.href });
      return c.toDataURL('image/jpeg', 0.9);
    });
    fs.writeFileSync(path.join(outDir, 'e-poster.jpg'), Buffer.from(poster.split(',')[1], 'base64'));
    console.log(`poster ${Date.now() - pt}ms`);
    await page.close();
  },
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
