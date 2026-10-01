// Screenshots of every overlay state through the real renderer + camera (src/dev/overlay.html):
//   node tools/dev/overlay-shots.mjs [filter ...]      → .cache/dev/overlay/<name>.png
import fs from 'node:fs';
import path from 'node:path';
import { start, root } from './overlay-harness.mjs';

const out = path.join(root, '.cache/dev/overlay');
fs.mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
const SHOTS = [
  ['a1-arrival-0.5s', 'arrival', { at: 500 }],
  ['a2-arrival-1.4s', 'arrival', { at: 1400 }],
  ['a3-arrival-2.8s', 'arrival', { at: 2800 }],
  ['a4-arrival-settled', 'arrival', { at: 4400 }],
  ['a5-arrival-iau', 'iau', {}],
  ['b1-drag-names', 'drag', {}],
  ['b2-drag-fov40', 'drag', { view: { az: 60, alt: 62, fov: 40 } }],
  ['b3-drag-iau', 'drag', { culture: 'iau' }],
  ['b4-release-0.9s', 'release', { after: 900 }],
  ['c1-select-altair', 'select', {}],
  ['c2-select-vega-iau', 'select', { star: 'Vega', culture: 'iau' }],
  ['d1-tags-moon', 'tags', {}],
  ['e1-marker', 'marker', {}],
  ['f1-pair-0.5', 'pair', { progress: 0.5 }],
  ['f2-pair-1.0', 'pair', { progress: 1 }],
  ['f3-pair-level', 'pairLevel', {}],
  ['g1-vault', 'vault', {}],
  ['g2-day-sun', 'day', {}],
  ['h1-ridge-clip', 'ridge', {}],
  ['h2-moonrise', 'moonrise', {}],
  ['i1-phases', 'phases', {}],
  ['j1-listen', 'listen', {}],
  ['k1-desktop', 'desktop', {}],
  ['k2-short-chrome', 'short', {}],
  ['l1-rest', 'rest', {}],
  ['m1-export-card', 'export', {}],
];

const h = await start();
try {
  const page = await h.open('dev/overlay.html');
  for (const [name, scene, opts] of SHOTS) {
    if (only.length && !only.some((o) => name.includes(o))) continue;
    const t = Date.now();
    const r = await page.evaluate((s, o) => window.scene(s, o), scene, opts);
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
    console.log(`${name} (${Date.now() - t} ms) ${JSON.stringify(r.info)}`);
  }
  if (h.errors.length) console.log('errors:\n' + h.errors.join('\n'));
} finally {
  await h.close();
}
