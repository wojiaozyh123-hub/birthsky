// Dev check: both subset fonts load in Chromium and actually render every glyph they must cover.
//   node tools/dev/platform-fonts.mjs      → screenshots in .cache/dev/, exit 1 on failure
// A glyph counts as covered when drawing it with '"<font>", serif' differs (pixels or advance) from 'serif'
// alone; a control character outside the subset must NOT differ (it falls back).
import path from 'node:path';
import { startServer, launch, watch, outDir, sleep } from './platform-harness.mjs';

const { server, base } = await startServer();
const browser = await launch();
const errors = [];
let failed = false;
try {
  for (const vp of [{ width: 390, height: 844, deviceScaleFactor: 2 }, { width: 360, height: 640, deviceScaleFactor: 2 }]) {
    const page = await browser.newPage();
    watch(page, errors);
    await page.setViewport({ ...vp, isMobile: true, hasTouch: true });
    await page.goto(base + 'dev/platform-fonts.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => window.__fontsReady === true, { timeout: 60000 });
    await sleep(200);
    const res = await page.evaluate(async () => {
      const DISPLAY = ['你来的那晚', '这是你来的那晚', '两个人的星空', '你是哪一天来到这个世界的？', 'TA 是哪一天出生的？', '用这个生日吗？', '那一夜', '关于'];
      const nawanChars = [...new Set([...DISPLAY.join(''), 'T', 'A', '？', '·'])].filter((c) => c !== ' ');
      const numChars = [...'0123456789.:·-'];
      const cv = document.createElement('canvas');
      cv.width = cv.height = 96;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const draw = (c, font) => {
        ctx.clearRect(0, 0, 96, 96);
        ctx.font = font;
        ctx.fillStyle = '#000';
        ctx.fillText(c, 8, 70);
        const d = ctx.getImageData(0, 0, 96, 96).data;
        let h = 0;
        for (let i = 3; i < d.length; i += 4) h = (h * 31 + d[i]) >>> 0;
        return { h, w: ctx.measureText(c).width, asc: ctx.measureText(c).actualBoundingBoxAscent };
      };
      const covered = (c, fam, weight) => {
        const a = draw(c, `${weight} 56px "${fam}", serif`), b = draw(c, `${weight} 56px serif`);
        return a.h !== b.h || Math.abs(a.w - b.w) > 0.01;
      };
      const loaded = [...document.fonts].map((f) => `${f.family}:${f.status}`);
      const nawanMissing = nawanChars.filter((c) => !covered(c, 'Nawan Serif', 400));
      const numMissing = numChars.filter((c) => !covered(c, 'Cormorant Lining', 500));
      // space: compare advances
      const spaceOwn = draw(' ', '500 56px "Cormorant Lining", serif').w, spaceFb = draw(' ', '500 56px serif').w;
      const controlFallsBack = !covered('猫', 'Nawan Serif', 400) && !covered('x', 'Cormorant Lining', 500);
      const widths = [...'0123456789'].map((c) => draw(c, '500 56px "Cormorant Lining"').w);
      const ascents = [...'0123456789'].map((c) => Math.round(draw(c, '500 56px "Cormorant Lining"').asc));
      const noHScroll = document.documentElement.scrollWidth <= innerWidth;
      return { loaded, nawanMissing, numMissing, spaceOwn, spaceFb, controlFallsBack, widths, ascents, noHScroll,
        check: document.fonts.check('24px "Nawan Serif"', '你来的那晚') && document.fonts.check('500 24px "Cormorant Lining"', '1998') };
    });
    const tabular = new Set(res.widths.map((w) => w.toFixed(3))).size === 1;
    const lining = Math.max(...res.ascents) - Math.min(...res.ascents) <= 3; // oldstyle figures would differ by ~14 px at 56 px
    const ok = !res.nawanMissing.length && !res.numMissing.length && res.controlFallsBack && tabular && lining && res.check
      && res.loaded.every((s) => s.endsWith(':loaded'));
    console.log(`${vp.width}×${vp.height}`, ok ? 'OK' : 'FAIL', JSON.stringify({ ...res, tabular, lining }));
    failed ||= !ok;
    const file = path.join(outDir, `platform-fonts-${vp.width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('  screenshot', file);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.log('page errors:\n  ' + errors.join('\n  ')); failed = true; }
process.exit(failed ? 1 : 0);
