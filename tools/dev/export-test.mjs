// EXPORT dev test: renders every format × style × text mode through PosterStudio (src/js/poster.js) for two
// people — 小明 (1998-07-14 22:00 杭州, the Milky Way core up) and 小雨 (2003-03-15 14:30 成都, born in
// daylight) — plus the 两个人 card and wallpaper, guest, lines, long-poem, unknown-time, desktop, tiling
// and 1080-fallback cases. JPEGs land in .cache/export/ (text-band crops in .cache/export/crops/).
// Every 便签 QR is re-encoded at JPEG q .80 and 0.5× scale and must decode (jsQR) to the right URL.
//   node tools/dev/export-test.mjs [name-substring ...] [--no-crops]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, '.cache/export');
const cropDir = path.join(outDir, 'crops');
fs.mkdirSync(cropDir, { recursive: true });
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const crops = !args.includes('--no-crops');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = u.pathname.startsWith('/node_modules/') ? path.join(root, decodeURIComponent(u.pathname)) : path.join(root, 'src', decodeURIComponent(u.pathname));
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const exe = path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await puppeteer.launch({
  executablePath: exe, headless: 'new', protocolTimeout: 600000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--lang=zh-CN'],
});

const errors = [];
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`  ${ok ? 'ok ' : 'FAIL'} ${msg}`); };
const save = (name, dataUrl) => fs.writeFileSync(name, Buffer.from(dataUrl.split(',')[1], 'base64'));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 1 });
  await page.emulateTimezone('Asia/Shanghai');
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`console.${m.type()}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`); });
  page.setDefaultTimeout(600000);
  await page.goto(base + 'dev/export.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.exportReady, { timeout: 120000 }).catch((e) => { console.log(errors.join('\n')); throw e; });

  // ---------------------------------------------------------------- pure geometry
  if (!only.length || only.includes('geometry')) {
    console.log('geometry');
    const sizes = await page.evaluate(() => window.helpers.sizes());
    const eq = (s, W, H) => s.W === W && s.H === H;
    check(eq(sizes.i15, 1179, 2556), `exportSize iPhone 15 → ${sizes.i15.W}×${sizes.i15.H} (1179×2556)`);
    check(eq(sizes.i15pm, 1290, 2796), `exportSize 430×932@3 → ${sizes.i15pm.W}×${sizes.i15pm.H} (1290×2796)`);
    check(eq(sizes.i14, 1170, 2532), `exportSize 390×844@3 → ${sizes.i14.W}×${sizes.i14.H} (1170×2532)`);
    check(eq(sizes.a360, 1080, 2400), `exportSize 360×800@3 → ${sizes.a360.W}×${sizes.a360.H} (1080×2400)`);
    check(eq(sizes.a780, 1080, 2340), `exportSize 360×780@3 → ${sizes.a780.W}×${sizes.a780.H} (1080×2340)`);
    check(eq(sizes.low, 1080, 1920), `exportSize 360×640@2 → ${sizes.low.W}×${sizes.low.H} (scaled up to 1080 wide)`);
    check(eq(sizes.land, 1170, 2532), `exportSize landscape screen → portrait ${sizes.land.W}×${sizes.land.H}`);
    check(sizes.tall.H <= 2868 && sizes.tall.W % 2 === 0, `exportSize tall screen capped: ${sizes.tall.W}×${sizes.tall.H}`);
    check(eq(sizes.desk[0], 1290, 2796) && eq(sizes.desk[1], 1080, 2400) && eq(sizes.desk[2], 2880, 1800) && eq(sizes.desk[3], 1290, 2796), 'desktop sizes cycle');
    check(eq(sizes.card, 1080, 1440), 'card 1080×1440');
    const fr = await page.evaluate(() => window.helpers.framing());
    const near = (a, b, e = 0.05) => Math.abs(a - b) < e;
    check(fr.wall.fov === 80 && near(fr.wall.alt, 25.17), `wallpaper framing fov 80 alt ${fr.wall.alt.toFixed(2)} (25.2 → horizon 0.78H)`);
    check(fr.card.fov === 76 && near(fr.card.alt, 17.35), `card framing fov 76 alt ${fr.card.alt.toFixed(2)} (horizon 0.70H)`);
    check(near(fr.pair.alt, 14.02), `pair card framing alt ${fr.pair.alt.toFixed(2)} (horizon 0.66H)`);
    console.log('  paper framing', fr.paper, 'desktop framing', fr.desk);
    const scrim = await page.evaluate(() => window.helpers.scrim());
    console.log('  wallpaper ground scrim by Δalt', JSON.stringify(scrim.map(([d, s]) => [d, +s.toFixed(2)])));
    check(scrim[0][1] === 0 && scrim[scrim.length - 1][1] === 1, 'scrim 0 at the default framing, 1 once the ground leaves');
    const nud = await page.evaluate(() => window.helpers.nudge('xh'));
    console.log('  clock nudge', JSON.stringify(nud));
    check(!!nud.nudge && Math.abs(nud.nudge.az - nud.edge.az) <= 10 && Math.abs(nud.nudge.alt - nud.edge.alt) <= 6, `clock nudge clears a Moon near the zone's edge: Δaz ${nud.nudge && (nud.nudge.az - nud.edge.az).toFixed(1)}° Δalt ${nud.nudge && (nud.nudge.alt - nud.edge.alt).toFixed(1)}°`);
    check(nud.mid === null, 'clock nudge leaves a Moon in the middle of the zone alone (no turn within ±10° / ±6° clears it)');
    for (const k of ['xm', 'day', 'xh', 'anon']) console.log(`  ${k}`, JSON.stringify(await page.evaluate((key) => window.personInfo(key), k)));
  }

  // ---------------------------------------------------------------- renders
  const cases = [];
  const W15 = { screenW: 393, screenH: 852, dpr: 3, screenCSSW: 393 };
  for (const person of ['xm', 'day']) {
    const extra = person === 'day' ? { dayMask: 0.14 } : {};
    for (const style of ['night', 'mono']) {
      for (const textMode of ['poem+date', 'poem', 'date', 'none']) cases.push({ name: `${person}-wall-${style}-${textMode.replace('+', '-')}`, person, format: 'wallpaper', style, textMode, ...W15, ...extra });
    }
    for (const style of ['night', 'mono', 'paper']) {
      for (const textMode of ['full', 'date', 'none']) cases.push({ name: `${person}-card-${style}-${textMode}`, person, format: 'card', style, textMode, ...extra });
    }
  }
  cases.push(
    { name: 'day-wall-night-daylight', person: 'day', format: 'wallpaper', style: 'night', textMode: 'poem+date', ...W15, dayMask: 1 },
    { name: 'day-card-night-daylight', person: 'day', format: 'card', style: 'night', textMode: 'full', dayMask: 1 },
    { name: 'xm-card-night-qroff', person: 'xm', format: 'card', style: 'night', textMode: 'full', qr: false },
    { name: 'xm-card-paper-qroff-none', person: 'xm', format: 'card', style: 'paper', textMode: 'none', qr: false },
    { name: 'xm-wall-night-lines', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', lines: true, ...W15 },
    { name: 'xm-card-paper-lines', person: 'xm', format: 'card', style: 'paper', textMode: 'full', lines: true },
    { name: 'xm-card-mono-lines-iau', person: 'xm', format: 'card', style: 'mono', textMode: 'full', lines: true, culture: 'iau' },
    { name: 'xm-wall-guest', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', subjectName: '小明', ...W15 },
    { name: 'xm-card-guest', person: 'xm', format: 'card', style: 'night', textMode: 'full', subjectName: '小明' },
    { name: 'xm-wall-own-line', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', sentence: '今晚的织女星，光出发于 2001 年。', ...W15 },
    { name: 'xm-wall-poem2', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', poem: { lines: ['星垂平野阔，', '月涌大江流。'], by: '杜甫', title: '旅夜书怀' }, ...W15 },
    { name: 'xm-wall-poem4', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', poem: { lines: ['一闪一闪亮晶晶，', '满天都是小星星。', '挂在天上放光明，', '好像许多小眼睛。'], by: '', title: '' }, ...W15 },
    { name: 'xm-wall-poem-serif', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', poemFont: 'serif', poem: { lines: ['似此星辰非昨夜，', '为谁风露立中宵。'], by: '黄景仁', title: '绮怀' }, ...W15 },
    { name: 'xm-card-poem', person: 'xm', format: 'card', style: 'night', textMode: 'full', sentence: { lines: ['星垂平野阔，', '月涌大江流。'], by: '杜甫', title: '旅夜书怀' } },
    { name: 'xm-card-poem4', person: 'xm', format: 'card', style: 'paper', textMode: 'full', sentence: { lines: ['一闪一闪亮晶晶，', '满天都是小星星。', '挂在天上放光明，', '好像许多小眼睛。'], by: '佚名', title: '小星星' } },
    { name: 'xm-card-own-line', person: 'xm', format: 'card', style: 'night', textMode: 'full', sentence: '那一年夏天，外婆说你来的时候下过雨' },
    { name: 'anon-card-night', person: 'anon', format: 'card', style: 'night', textMode: 'full' },
    { name: 'anon-wall-night', person: 'anon', format: 'wallpaper', style: 'night', textMode: 'poem+date', ...W15 },
    { name: 'xm-wall-scrim', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', dAlt: 9, ...W15 },
    { name: 'xm-card-scrim', person: 'xm', format: 'card', style: 'night', textMode: 'full', dAlt: 7 },
    { name: 'xm-wall-desktop', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', desktop: true, preset: 2, screenCSSW: 1440 },
    { name: 'xm-wall-1080x1920', person: 'xm', format: 'wallpaper', style: 'mono', textMode: 'poem+date', screenW: 360, screenH: 640, dpr: 2, screenCSSW: 360 },
    { name: 'xh-wall-night-moon', person: 'xh', format: 'wallpaper', style: 'night', textMode: 'poem+date', ...W15 },
    { name: 'xh-card-night-moon', person: 'xh', format: 'card', style: 'night', textMode: 'full' },
    { name: 'xh-card-mono-moon', person: 'xh', format: 'card', style: 'mono', textMode: 'full' },
    { name: 'xh-card-paper-moon', person: 'xh', format: 'card', style: 'paper', textMode: 'full' },
    { name: 'sirius-wall-night', person: 'sirius', format: 'wallpaper', style: 'night', textMode: 'date', view: { az: 180, alt: 25.17, fov: 80 }, ...W15 },
    { name: 'sirius-wall-night-maxpoint24', person: 'sirius', format: 'wallpaper', style: 'night', textMode: 'date', view: { az: 180, alt: 25.17, fov: 80 }, maxPoint: 24, ...W15 },
    { name: 'xm-card-after-release', person: 'xm', format: 'card', style: 'night', textMode: 'full', release: true },
    { name: 'pair-card-night', pair: ['xm', 'xh'], format: 'card', style: 'night', textMode: 'full' },
    { name: 'pair-card-mono', pair: ['xm', 'xh'], format: 'card', style: 'mono', textMode: 'full' },
    { name: 'pair-card-paper', pair: ['xm', 'xh'], format: 'card', style: 'paper', textMode: 'full' },
    { name: 'pair-card-night-date', pair: ['xm', 'xh'], format: 'card', style: 'night', textMode: 'date' },
    { name: 'pair-wall-night', pair: ['xm', 'xh'], format: 'wallpaper', style: 'night', textMode: 'poem+date', ...W15 },
    { name: 'pair2-card-night', pair: ['xh', 'day'], format: 'card', style: 'night', textMode: 'full' },
  );

  const results = {};
  for (const c of cases) {
    if (only.length && !only.some((o) => c.name.includes(o))) continue;
    const r = await page.evaluate((cfg) => window.exportCase(cfg), c).catch((e) => ({ error: String(e) }));
    if (r.error) { check(false, `${c.name}: ${r.error}`); continue; }
    results[c.name] = r;
    const file = path.join(outDir, `${c.name}.jpg`);
    save(file, r.dataUrl);
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`${c.name}: ${r.W}×${r.H} ${kb} KB, ${r.ms} ms, view az ${r.view.az.toFixed(1)} alt ${r.view.alt.toFixed(1)} fov ${r.view.fov}${r.hero ? ` hero ${r.hero.kind}` : ''}${r.groundScrim ? ` scrim ${r.groundScrim.toFixed(2)}` : ''}${r.qr ? ` QR v${r.qr.version} ${r.qr.modules}m ${r.qr.size.toFixed(1)}px` : ''}`);
    if (c.format === 'card') check(r.W === 1080 && r.H === 1440, `${c.name} is 1080×1440`);
    if (c.format === 'wallpaper' && !c.desktop && c.screenW === 393) check(r.W === 1179 && r.H === 2556, `${c.name} is 1179×2556`);
    if (c.format === 'card' && c.qr !== false) {
      check(!!r.qr, `${c.name} has a QR`);
      for (const [scale, q] of [[0.5, 0.8], [1, 0.92]]) {
        const d = await page.evaluate((u, e, s, qq) => window.qrCheck(u, e, s, qq), r.dataUrl, r.url, scale, q);
        check(d.ok, `${c.name} QR decodes after JPEG q${q} at ${scale}× (${d.w}×${d.h}) → ${d.data ? (d.data === r.url ? 'the right URL' : d.data) : 'nothing'}`);
      }
    }
    if (crops && c.style === 'paper') {
      const png = await page.evaluate((u) => window.crop(u, 300, 250, 540, 540), r.dataUrl);
      save(path.join(cropDir, `${c.name}-sky.png`), png);
    }
    if (crops) {
      const box = c.format === 'card' ? [0, 900, 1080, 540] : r.W > r.H ? [0, Math.round(r.H * 0.72), Math.round(r.W * 0.5), Math.round(r.H * 0.28)] : [0, Math.round(r.H * 0.70), r.W, Math.round(r.H * 0.22)];
      const png = await page.evaluate((u, b) => window.crop(u, ...b), r.dataUrl, box);
      save(path.join(cropDir, `${c.name}.png`), png);
    }
  }

  // ---------------------------------------------------------------- viewfinder preview (text layer only)
  if (!only.length || only.includes('preview')) {
    console.log('preview');
    for (const cfg of [{ format: 'wallpaper', style: 'night', textMode: 'poem+date' }, { format: 'card', style: 'night', textMode: 'full' }, { format: 'card', style: 'paper', textMode: 'full' }]) {
      const r = await page.evaluate((c) => window.previewCase(c), cfg).catch((e) => ({ error: String(e) }));
      if (r.error) { check(false, `previewText ${cfg.format}/${cfg.style}: ${r.error}`); continue; }
      save(path.join(cropDir, `preview-${cfg.format}-${cfg.style}.png`), r.url);
      check(cfg.format !== 'card' || (r.qr && r.qr.size >= 156), `previewText ${cfg.format}/${cfg.style} drew${r.qr ? ` (QR ${r.qr.size} px)` : ''}`);
    }
  }

  // ---------------------------------------------------------------- contact sheets (review aid)
  if (crops && Object.keys(results).length) {
    const sheetDir = path.join(outDir, 'sheets');
    fs.mkdirSync(sheetDir, { recursive: true });
    const names = Object.keys(results);
    const groups = [];
    const walls = names.filter((n) => results[n].H > results[n].W * 1.5), cards = names.filter((n) => !walls.includes(n) && results[n].W < results[n].H);
    for (let i = 0; i < walls.length; i += 6) groups.push(['walls', walls.slice(i, i + 6), 900]);
    for (let i = 0; i < cards.length; i += 4) groups.push(['cards', cards.slice(i, i + 4), 720]);
    let k = 0;
    for (const [kind, list, h] of groups) {
      const url = await page.evaluate((items, hh) => window.sheet(items, hh), list.map((n) => ({ name: n, url: results[n].dataUrl })), h);
      save(path.join(sheetDir, `${String(++k).padStart(2, '0')}-${kind}.jpg`), url);
    }
    console.log(`contact sheets: ${k} in ${path.relative(root, sheetDir)}`);
  }

  // ---------------------------------------------------------------- tiling and the 1080 fallback
  if (!only.length || only.includes('tiling')) {
    console.log('tiling');
    const cfg = { name: 'tile', person: 'xm', format: 'wallpaper', style: 'night', textMode: 'poem+date', ...W15 };
    // the background dither is keyed to gl_FragCoord, which restarts in every tile: compare without it
    const whole = await page.evaluate((x) => window.exportCase({ ...x, debugState: { dither: 0 } }), cfg);
    const tiled = await page.evaluate((x) => window.exportCase({ ...x, maxTile: 1400, debugState: { dither: 0 } }), cfg);
    save(path.join(outDir, 'tiling-3tiles.jpg'), tiled.dataUrl);
    const d = await page.evaluate((a, b) => window.diff(a, b), whole.dataUrl, tiled.dataUrl);
    // tiles as poster.js cuts them: inner = 1400 − 2·64, n = ceil(H / inner), seams every ceil(H / n) rows
    const n = Math.ceil(2556 / (1400 - 128)), step = Math.ceil(2556 / n);
    const seams = Array.from({ length: n - 1 }, (_, i) => (i + 1) * step);
    const atSeam = d.rows.filter(([y]) => seams.some((s) => Math.abs(y - s) <= 16));
    if (d.rows.length) console.log('  JPEG rows with differences > 2', JSON.stringify(d.rows.map(([y]) => y)), 'seams', seams);
    check(!atSeam.length, `3 tiles (1400 px, 64 px overlap): nothing differs within 16 rows of the seams ${seams.join(', ')}`);
    check(d.max <= 10 && d.mean < 0.005, `3 tiles vs one pass: max channel diff ${d.max}, mean ${d.mean.toFixed(4)} (float rounding of the shifted centre, amplified by JPEG blocks)`);
    const big = await page.evaluate((x) => window.exportCase({ ...x, size: { W: 16400, H: 35552 } }), cfg).catch((e) => ({ error: String(e) }));
    if (big.error) check(false, `fallback: ${big.error}`);
    else {
      save(path.join(outDir, 'fallback-1080.jpg'), big.dataUrl);
      check(big.fallback === '1080' && big.W === 1080 && big.H === 2 * Math.round(35552 * 1080 / 16400 / 2), `too-wide frame falls back to ${big.W}×${big.H} (fallback ${big.fallback})`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.log('page errors:\n' + errors.join('\n')); }
console.log(failures.length ? `\n${failures.length} FAILED:\n${failures.join('\n')}` : '\nall checks passed');
process.exit(failures.length || errors.length ? 1 : 0);
