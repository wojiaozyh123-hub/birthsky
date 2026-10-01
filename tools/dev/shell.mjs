// Dev only: screenshots every shell state (src/dev/shell.html) at 360×640, 390×844 (st 47 / sb 34),
// 430×932 (st 59 / sb 34) and 1440×900, and checks each one:
//   · no horizontal scroll, no visible text outside the viewport
//   · no overlaps between the stage slots (caption, strip, summary / hint, meta, actions, toggles, …)
//   · contrast of every visible text run against the pixels behind it (text hidden for the measurement)
//   node tools/dev/shell.mjs [state …] [--vp=390] [--no-contrast]   → .cache/dev/shell/<w>x<h>/<state>.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, launch } from './shell-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, '.cache/dev/shell');
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const vpArg = args.find((a) => a.startsWith('--vp='))?.slice(5);
const contrast = !args.includes('--no-contrast');

const VIEWPORTS = [
  { w: 390, h: 844, st: 47, sb: 34, dsf: 2, mobile: true },
  { w: 360, h: 640, st: 0, sb: 0, dsf: 2, mobile: true },
  { w: 430, h: 932, st: 59, sb: 34, dsf: 2, mobile: true },
  { w: 1440, h: 900, st: 0, sb: 0, dsf: 1, mobile: false },
].filter((v) => !vpArg || String(v.w) === vpArg);

// states caught mid-animation on purpose
const NO_CONTRAST = new Set(['intro-timed']);
// slots that must never overlap each other when both are visible
const SLOTS = ['#cap-text', '#cap-acts', '#strip-in', '#summary', '#hint-slot > span', '#meta .mi', '#actions', '#listen-status', '#toggles',
  '#pair-where', '#pair-switch', '#pair-block', '#intro-title', '#intro-lede', '#intro-cta', '#intro-hint', '#btn-about',
  '#r-readout', '#r-band', '#r-btns', '#rw-card', '#rw-main', '#rw-skip', '#pi-title', '#pi-body', '#pi-acts', '#kf-top', '#kf-note', '#kf-plate',
  '#toast > span', '#share-guide-l1', '#share-guide-l2'];

function inspect(slots) {
  const W = innerWidth, H = innerHeight;
  const opacityChain = (el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= +cs.opacity;
    }
    return o;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && opacityChain(el) > 0.05;
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const out = { scroll: document.scrollingElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1, overflow: [], overlaps: [], texts: [] };
  // slot overlaps
  const vis = slots.map((s) => [s, document.querySelector(s)]).filter(([, el]) => visible(el) && (el.textContent.trim() || el.querySelector('*')));
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const [sa, a] = vis[i], [sb, b] = vis[j];
      if (a.contains(b) || b.contains(a)) continue;
      const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
      const ix = Math.min(A.right, B.right) - Math.max(A.left, B.left);
      const iy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
      if (ix > 1 && iy > 1) out.overlaps.push(`${sa} × ${sb} (${ix.toFixed(0)}×${iy.toFixed(0)})`);
    }
  }
  // text runs: overflow + contrast inputs
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || el.closest('script, style, .odo .os, .r-strip, .kf-ghost, #bg, .dev-hline, .kf-text, .kf-clockline')) continue;
    seen.add(el);
    const o = opacityChain(el);
    if (o <= 0.05) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) continue;
    // clipped by a scrolling / overflow-hidden ancestor?
    let clip = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX) && p !== document.body && p.id !== 'app') { clip = p.getBoundingClientRect(); break; }
    }
    const cs = getComputedStyle(el);
    const m = cs.color.match(/rgba?\(([^)]+)\)/);
    const [r, g, b, a = 1] = m ? m[1].split(',').map(Number) : [255, 255, 255, 1];
    for (const rr of rects) {
      if (clip && (rr.bottom <= clip.top + 1 || rr.top >= clip.bottom - 1)) continue;
      if (rr.left < -1 || rr.right > W + 1) out.overflow.push(`${el.id || el.className || el.tagName}: 「${el.textContent.trim().slice(0, 16)}」 x ${rr.left.toFixed(0)}–${rr.right.toFixed(0)}`);
      if (rr.top >= H || rr.bottom <= 0) continue;
      out.texts.push({ key: (el.id ? `#${el.id}` : el.className || el.tagName).toString().slice(0, 28), text: el.textContent.trim().slice(0, 14),
        x: Math.max(0, rr.left), y: Math.max(0, rr.top), w: Math.min(W, rr.right) - Math.max(0, rr.left), h: Math.min(H, rr.bottom) - Math.max(0, rr.top),
        rgb: [r, g, b], alpha: a * o, size: parseFloat(cs.fontSize) });
    }
  }
  return out;
}

async function measureContrast(page, texts) {
  // hide every glyph (and its shadow), screenshot, then read the pixels behind each text run
  await page.addStyleTag({ content: '*{color:transparent!important;text-shadow:none!important;caret-color:transparent!important}input::placeholder{color:transparent!important}', }).then((h) => page.evaluate((el) => { el.id = 'dev-hide'; }, h));
  await new Promise((r) => setTimeout(r, 60));
  const png = await page.screenshot({ encoding: 'base64' });
  await page.evaluate(() => document.getElementById('dev-hide')?.remove());
  return page.evaluate(async (b64, list) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const k = img.width / innerWidth;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (r, gg, b) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
    return list.map((t) => {
      const x = Math.floor(t.x * k), y = Math.floor(t.y * k), w = Math.max(1, Math.floor(t.w * k)), h = Math.max(1, Math.floor(t.h * k));
      const d = g.getImageData(x, y, w, h).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4 * 3) px.push([L(d[i], d[i + 1], d[i + 2]), d[i], d[i + 1], d[i + 2]]);
      px.sort((a, b) => a[0] - b[0]);
      // the text colour composited over the brighter background (90th percentile pixel), in sRGB like browsers
      const bb = (px[Math.floor(px.length * 0.9)] || [0, 0, 0, 0]).slice(1);
      const tc = t.rgb.map((c, i) => c * t.alpha + bb[i] * (1 - t.alpha));
      const lt = L(...tc), lb = L(...bb);
      const ratio = (Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05);
      return { ...t, ratio: +ratio.toFixed(2) };
    });
  }, png, texts);
}

const { server, base } = await serve();
const browser = await launch();
const browsers = [browser];
const report = [];
try {
  const probe = await browser.newPage();
  await probe.goto(`${base}dev/shell.html?state=rest&settle=0`);
  await probe.waitForFunction(() => window.shellReady, { timeout: 60000 });
  const states = (await probe.evaluate(() => window.shellStates)).filter((s) => !only.length || only.includes(s));
  await probe.close();
  // one browser per viewport: a page that is not in front is 'hidden' and gets no animation frames
  await Promise.all(VIEWPORTS.map(async (vp, i) => {
    const dir = path.join(outDir, `${vp.w}x${vp.h}`);
    fs.mkdirSync(dir, { recursive: true });
    const b = i === 0 ? browser : await launch();
    if (i) browsers.push(b);
    const page = (await b.pages())[0] || await b.newPage();
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile });
    await page.emulateTimezone('Asia/Shanghai');
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (/Failed to load resource/.test(m.text())) return; if (['error', 'warning'].includes(m.type())) errors.push(`console.${m.type()}: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push(`http ${r.status()}: ${r.url()}`); });
    for (const state of states) {
      errors.length = 0;
      await page.goto(`${base}dev/shell.html?state=${state}&st=${vp.st}&sb=${vp.sb}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      try {
        await page.waitForFunction(() => window.shellReady, { timeout: 60000, polling: 200 });
      } catch (e) {
        const diag = await page.evaluate(() => JSON.stringify({ shell: !!window.shell, fonts: document.fonts.status, bg: document.getElementById('bg')?.src, done: document.getElementById('bg')?.complete, vis: document.visibilityState })).catch((x) => x.message);
        report.push({ vp: `${vp.w}x${vp.h}`, state, errors: [...errors, e.message, diag] });
        continue;
      }
      await page.screenshot({ path: path.join(dir, `${state}.png`) });
      const r = await page.evaluate(inspect, SLOTS);
      let low = [];
      if (contrast && r.texts.length && !NO_CONTRAST.has(state)) {
        const m = await measureContrast(page, r.texts);
        low = m.filter((t) => (t.alpha >= 0.8 && t.ratio < 4.5) || (t.alpha >= 0.5 && t.ratio < 3) || t.ratio < 2)
          .map((t) => `${t.key} 「${t.text}」 ${t.ratio}:1 (α${t.alpha.toFixed(2)})`);
      }
      report.push({ vp: `${vp.w}x${vp.h}`, state, scroll: r.scroll, overflow: r.overflow, overlaps: r.overlaps, contrast: low, errors: [...errors] });
    }
    await page.close();
  }));
} finally {
  await Promise.all(browsers.map((b) => b.close()));
  server.close();
}
let bad = 0;
report.sort((a, b) => a.state.localeCompare(b.state) || a.vp.localeCompare(b.vp));
for (const r of report) {
  const issues = [
    r.scroll && 'horizontal scroll',
    ...(r.overflow || []).map((x) => `overflow ${x}`),
    ...(r.overlaps || []).map((x) => `overlap ${x}`),
    ...(r.contrast || []).map((x) => `contrast ${x}`),
    ...(r.errors || []),
  ].filter(Boolean);
  if (issues.length) bad++;
  console.log(`${issues.length ? '✗' : '✓'} ${r.state.padEnd(15)} ${r.vp}${issues.length ? `\n    ${issues.join('\n    ')}` : ''}`);
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
console.log(`\n${report.length - bad}/${report.length} clean → ${path.relative(root, outDir)}/`);
