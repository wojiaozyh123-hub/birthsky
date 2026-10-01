// Renders bare-sky frames through the new camera + renderer for visual review (spec §3.1–3.7):
// first person 72° with the horizon at 0.82H, the 100° vault looking up, the rewind framing facing the
// pole with trails, desktop, a short phone, listen flares and two-skies dimming.
//   node tools/dev/core-frames.mjs [name ...]      → .cache/dev/core/<name>.png
import fs from 'node:fs';
import path from 'node:path';
import { start, root } from './core-harness.mjs';

const out = path.join(root, '.cache/dev/core');
fs.mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);

// 1998-07-14 22:00 in Hangzhou (UTC+8)
const HZ = { date: '1998-07-14T14:00:00Z', lat: 30.29, lon: 120.16 };
const frames = [
  { name: 'a-stand-72', w: 390, h: 844, dpr: 3, view: { az: 'core', fov: 72, horizon: 0.82 } },
  { name: 'b-vault-100', w: 390, h: 844, dpr: 3, view: { az: 180, alt: 89, fov: 100 } },
  { name: 'c-rewind-pole', w: 390, h: 844, dpr: 3, view: { az: 0, alt: Math.min(34, Math.max(16, 30.29 - 2)), fov: 84 }, rewind: { from: 0.18, to: 0.62 } },
  { name: 'd-desktop-60', w: 1440, h: 900, dpr: 1, view: { az: 'core', fov: 60, horizon: 0.84 } },
  { name: 'e-short-72', w: 360, h: 640, dpr: 2, view: { az: 'core', fov: 72, horizon: 0.80 } },
  { name: 'f-listen', w: 390, h: 844, dpr: 3, view: { az: 205, alt: 35, fov: 84 }, listen: { behind: 1.5 } },
  { name: 'g-shared', w: 390, h: 844, dpr: 3, view: { az: 'core', fov: 72, horizon: 0.70 }, state: { zB: [0.34, 0.0, 0.94], sharedDim: 0.25, sharedT: 1 } },
  { name: 'h-zoom-30', w: 390, h: 844, dpr: 3, view: { az: 'core', alt: 22, fov: 30 } },
  { name: 'i-wide-110', w: 390, h: 844, dpr: 3, view: { az: 'core', alt: 30, fov: 110 } },
  { name: 'j-equator-rewind', w: 390, h: 844, dpr: 3, date: '1998-07-14T15:00:00Z', lat: 1.35, lon: 103.8, view: { az: 0, alt: 16, fov: 84 }, rewind: { from: 0.18, to: 0.62 } },
];

const h = await start({ width: 390, height: 844 });
try {
  const page = await h.open('dev/core-frames.html');
  await page.waitForFunction(() => window.framesReady, { timeout: 120000 }).catch((e) => { console.log(h.errors.join('\n')); throw e; });
  console.log('catalog', JSON.stringify(await page.evaluate((c) => window.coreInfo(c), HZ)));
  for (const f of frames) {
    if (only.length && !only.some((o) => f.name.includes(o))) continue;
    const t = Date.now();
    const r = await page.evaluate((cfg) => window.renderFrame(cfg), { ...HZ, ...f });
    fs.writeFileSync(path.join(out, `${f.name}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
    console.log(`${f.name}: az ${r.cam.az.toFixed(1)} alt ${r.cam.alt.toFixed(2)} fov ${r.cam.fov} P ${r.cam.P.toFixed(3)} (${Date.now() - t} ms)`);
  }
  if (h.errors.length) console.log('errors:\n' + h.errors.join('\n'));
} finally {
  await h.close();
}
