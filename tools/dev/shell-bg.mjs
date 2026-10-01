// Dev only: renders the real-sky backdrops the shell screenshots sit on (stand, form, rewind, pair,
// listen, keep framings at each test viewport) through core's dev page src/dev/core-frames.html.
//   node tools/dev/shell-bg.mjs            → .cache/dev/shell/bg/<scene>-<w>x<h>.jpg
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { start, root } from './core-harness.mjs';

const out = path.join(root, '.cache/dev/shell/bg');
fs.mkdirSync(out, { recursive: true });
const HZ = { date: '1998-07-14T14:00:00Z', lat: 30.29, lon: 120.16 };
const VIEWS = [[390, 844], [360, 640], [430, 932], [1440, 900]];
const alt = (frac, fov) => Math.atan((2 * frac - 1) * Math.tan(fov * Math.PI / 360)) * 180 / Math.PI;

function scenes(w, h) {
  const desk = w >= 960;
  const short = h < 700;
  const sf = desk ? 60 : 72;
  const sh = desk ? 0.84 : short ? 0.80 : 0.82;
  return [
    ['stand', { view: { az: 'core', fov: sf, alt: alt(sh, sf), Pfixed: 0 } }],
    ['intro', { view: { az: 'core', fov: desk ? 60 : 70, alt: alt(desk ? 0.84 : 0.82, desk ? 60 : 70), Pfixed: 0 } }],
    ['form', { view: { az: 0, fov: 72, alt: alt(short ? 0.36 : 0.42, 72), Pfixed: 0 }, state: { exposure: 0.7 } }],
    ['rewind', { view: { az: 0, alt: 28.3, fov: desk ? 66 : 84, Pfixed: 0 }, rewind: { from: 0.18, to: 0.62 } }],
    ['pair', { view: { az: 'core', fov: sf, alt: alt(0.60, sf), Pfixed: 0 }, state: { zB: [0.34, 0.0, 0.94], sharedDim: 0.25, sharedT: 1 } }],
    ['listen', { view: { az: 205, alt: 35, fov: desk ? 66 : 84, Pfixed: 0 }, listen: { behind: 1.5 } }],
    ['keep', { view: { az: 'core', fov: 80, alt: alt(0.78, 80), Pfixed: 0 } }],
    ['dim', { view: { az: 'core', fov: sf, alt: alt(sh, sf), Pfixed: 0 }, state: { exposure: 0.55 } }],
    ['invite', { view: { az: 'core', fov: sf, alt: alt(sh, sf), Pfixed: 0 }, state: { exposure: 0.5 } }],
  ];
}

const only = process.argv.slice(2);
const h = await start({ width: 390, height: 844 });
try {
  const page = await h.open('dev/core-frames.html');
  await page.waitForFunction(() => window.framesReady, { timeout: 180000 });
  for (const [w, hh] of VIEWS) {
    for (const [name, cfg] of scenes(w, hh)) {
      const file = path.join(out, `${name}-${w}x${hh}.jpg`);
      if (only.length && !only.some((o) => `${name}-${w}x${hh}`.includes(o))) continue;
      if (!only.length && fs.existsSync(file)) continue;
      const t = Date.now();
      const r = await page.evaluate((c) => window.renderFrame(c), { ...HZ, ...cfg, w, h: hh, dpr: w >= 960 ? 1 : 2 });
      const png = file.replace(/\.jpg$/, '.png');
      fs.writeFileSync(png, Buffer.from(r.url.split(',')[1], 'base64'));
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', png, '--out', file], { stdio: 'ignore' });
      fs.unlinkSync(png);
      console.log(`${name}-${w}x${hh} ${Date.now() - t} ms`);
    }
  }
  if (h.errors.length) console.log(h.errors.join('\n'));
} finally {
  await h.close();
}
